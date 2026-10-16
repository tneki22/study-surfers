/** Дублёры учитываются отдельно: отпускание W не отменяет всё ещё зажатую ↑. */
export class SpeedKeys {
  private held = new Set<string>();
  change(code: string, pressed: boolean): boolean {
    if (!["KeyW", "ArrowUp", "KeyS", "ArrowDown"].includes(code)) return false;
    if (pressed) this.held.add(code); else this.held.delete(code);
    return true;
  }
  get accelerating() { return this.held.has("KeyW") || this.held.has("ArrowUp"); }
  get braking() { return this.held.has("KeyS") || this.held.has("ArrowDown"); }
  clear() { this.held.clear(); }
}
