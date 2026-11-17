// A small state machine for entities: named states with an `update` that returns the next state (or nothing to
// stay) and an optional `enter`. The state of each entity is a number the owner keeps in its own table, so it is
// saved with the snapshot; the machine itself is only the code. An app adds states (waiting, boarding, riding,
// inside) without writing a tick loop of its own: the owner runs `step` for every entity each tick.

export interface StateDef<C> {
  /** Called every tick while in the state; returns the next state's id, or nothing to stay. */
  update?: (entity: number, ctx: C) => number | void;
  /** Called once when the state is entered. */
  enter?: (entity: number, ctx: C) => void;
}

/** Transitions a single `step` may take at most (a chain of states that hand over at once). */
const MAX_CHAIN = 8;

export class StateMachine<C> {
  private readonly names: string[] = [];
  private readonly defs: StateDef<C>[] = [];

  /** Adds a state and returns its id (ids count up from 0 in the order of definition). */
  define(name: string, def: StateDef<C> = {}): number {
    if (this.names.includes(name)) throw new Error(`StateMachine: state "${name}" exists`);
    this.names.push(name);
    this.defs.push(def);
    return this.names.length - 1;
  }

  /** Id of a named state. */
  id(name: string): number {
    const i = this.names.indexOf(name);
    if (i < 0) throw new Error(`StateMachine: no state "${name}"`);
    return i;
  }

  name(id: number): string {
    return this.names[id] ?? `?${id}`;
  }

  get size(): number {
    return this.names.length;
  }

  /** Enters a state: runs its `enter`. The owner stores the returned id. */
  enter(entity: number, state: number, ctx: C): number {
    this.defs[state]?.enter?.(entity, ctx);
    return state;
  }

  /**
   * One tick for one entity in `state`: runs `update`, follows the returned state (entering it) up to a few hand-overs
   * in the same tick, and returns the state it ends in.
   */
  step(entity: number, state: number, ctx: C, onChange?: (from: number, to: number) => void): number {
    let s = state;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const def = this.defs[s];
      if (!def?.update) return s;
      const next = def.update(entity, ctx);
      if (next === undefined || next === s) return s;
      onChange?.(s, next);
      s = this.enter(entity, next, ctx);
    }
    return s;
  }
}
