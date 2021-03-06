'use strict';

import {ChangeDetectorRef} from '@angular/core';

import {
  DefaultIterableDifferFactory,
  CollectionChangeRecord,
  DefaultIterableDiffer
} from '@angular/core/src/change_detection/differs/default_iterable_differ';

import {ObservableWrapper} from '@angular/core/src/facade/async';

import {
  MongoCursorObserver,
  AddChange,
  MoveChange,
  RemoveChange,
  UpdateChange
} from './mongo_cursor_observer';

export interface ObserverFactory {
  create(cursor: Object): Object;
}

function checkIfMongoCursor(cursor): boolean {
  return MongoCursorObserver.isCursor(cursor);
}

// Creates an MongoCursorObserver instance for a Mongo.Cursor instance.
// Add one more level of abstraction, but currently is not really needed.
class MongoCursorObserverFactory implements ObserverFactory {
  create(cursor: Object): Object {
    if (checkIfMongoCursor(cursor)) {
      return new MongoCursorObserver(<Mongo.Cursor<any>>cursor);
    }
    return null;
  }
}

// An instance of this factory (see providers.ts) is registered globally
// as one of the providers of collection differs.
// These providers are being checked by an ngFor instance to find out which
// differ it needs to create and use for the current collection.
export class MongoCursorDifferFactory extends DefaultIterableDifferFactory {
  supports(obj: Object): boolean { return checkIfMongoCursor(obj); }

  create(cdRef: ChangeDetectorRef): MongoCursorDiffer {
    return new MongoCursorDiffer(cdRef, new MongoCursorObserverFactory());
  }
}

const trackById = (index, item) => item._id;


/**
 * A class that implements Angular 2's concept of differs for ngFor.
 * API consists mainly of diff method and methods like forEachAddedItem
 * that is being run on each change detection cycle to apply new changes if any.
 */
export class MongoCursorDiffer extends DefaultIterableDiffer {
  private _inserted: Array<CollectionChangeRecord> = [];
  private _removed: Array<CollectionChangeRecord> = [];
  private _moved: Array<CollectionChangeRecord> = [];
  private _updated: Array<CollectionChangeRecord> = [];
  private _curObserver: MongoCursorObserver;
  private _lastChanges: Array<AddChange | MoveChange | RemoveChange>;
  private _listSize: number = 0;
  private _cursor: Mongo.Cursor<any>;
  private _obsFactory: ObserverFactory;
  private _subscription: Object;
  private _zone = Zone.current;

  constructor(cdRef: ChangeDetectorRef, obsFactory: ObserverFactory) {
    super(trackById);
    this._obsFactory = obsFactory;
  }

  forEachAddedItem(fn: Function) {
    for (let i = 0; i < this._inserted.length; i++) {
      fn(this._inserted[i]);
    }
  }

  forEachMovedItem(fn: Function) {
    for (let i = 0; i < this._moved.length; i++) {
      fn(this._moved[i]);
    }
  }

  forEachRemovedItem(fn: Function) {
    for (let i = 0; i < this._removed.length; i++) {
      fn(this._removed[i]);
    }
  }

  forEachIdentityChange(fn: Function) {
    for (let i = 0; i < this._updated.length; i++) {
      fn(this._updated[i]);
    }
  }

  diff(cursor: Mongo.Cursor<any>) {
    this._reset();

    let newCursor = false;
    if (cursor && this._cursor !== cursor) {
      newCursor = true;
      this._destroyObserver();
      this._cursor = cursor;
      this._curObserver = <MongoCursorObserver>this._obsFactory.create(cursor);
      this._subscription = ObservableWrapper.subscribe(this._curObserver,
        changes => {
          this._zone.run(() => { this._updateLatestValue(changes); });
        });
    }

    if (this._lastChanges) {
      this._applyChanges(this._lastChanges);
    }

    /**
     * If either last changes or new cursor is true, then
     * return "this" to notify Angular2 to re-build views.
     * If last changes or new cursor are true simultaneously
     * means that Mongo cursor has been changed and it's expected
     * that last changes (if any) of that cursor are additions only
     * (otherwise it won't likely work).
     * So removals of the previous cursor and additions of
     * the new one will processed at the same time.
     */
    if (this._lastChanges || newCursor) {
      this._lastChanges = null;
      return this;
    }

    return null;
  }

  onDestroy() {
    this._destroyObserver();
  }

  get observer() {
    return this._curObserver;
  }

  _destroyObserver() {
    if (this._curObserver) {
      this._curObserver.destroy();
    }

    this._applyCleanup();
  }

  _updateLatestValue(changes) {
    this._lastChanges = changes;
  }

  _reset() {
    this._inserted.length = 0;
    this._moved.length = 0;
    this._removed.length = 0;
    this._updated.length = 0;
  }

  // Reset previous state of the differ by removing all currently shown documents.
  _applyCleanup() {
    for (let index = 0; index < this._listSize; index++) {
      this._removed.push(this._createChangeRecord(
        null, index, null));
    }
    this._listSize = 0;
  }

  _applyChanges(changes) {
    for (let i = 0; i < changes.length; i++) {
      if (changes[i] instanceof AddChange) {
        this._inserted.push(this._createChangeRecord(
          changes[i].index, null, changes[i].item));
        this._listSize++;
      }

      if (changes[i] instanceof MoveChange) {
        this._moved.push(this._createChangeRecord(
          changes[i].toIndex, changes[i].fromIndex, changes[i].item));
      }

      if (changes[i] instanceof RemoveChange) {
        this._removed.push(this._createChangeRecord(
          null, changes[i].index, changes[i].item));
        this._listSize--;
      }

      if (changes[i] instanceof UpdateChange) {
        this._updated.push(this._createChangeRecord(
          changes[i].index, null, changes[i].item));
      }
    }
  }

  _createChangeRecord(currentIndex, prevIndex, item) {
    let record = new CollectionChangeRecord(item, trackById);
    record.currentIndex = currentIndex;
    record.previousIndex = prevIndex;
    return record;
  }
}
