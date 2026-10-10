type FocusTarget = Pick<HTMLElement, "isConnected" | "focus">;
type Control = { target: FocusTarget };

/** Current mounted controls only: a refreshed card replaces the original opener. */
export class PropertyDetailFocus {
  private controls = new Map<string, Map<string, Control>>();
  private selection: { scope: string; id: string } | null = null;
  private headingPending = false;

  register(scope: string, id: string, target: FocusTarget) {
    let controls = this.controls.get(scope);
    if (!controls) {
      controls = new Map();
      this.controls.set(scope, controls);
    }
    const control = { target };
    controls.set(id, control);
    return () => {
      // A late cleanup must not remove a newer ref, even if React reused the same DOM node.
      if (this.controls.get(scope) !== controls || controls.get(id) !== control) return;
      controls.delete(id);
      if (!controls.size) this.controls.delete(scope);
    };
  }

  open(scope: string, id: string) {
    this.selection = { scope, id };
    this.headingPending = true;
  }

  show(scope: string, enabled: boolean, heading: FocusTarget | null) {
    if (!enabled || this.selection?.scope !== scope || !this.headingPending || !heading?.isConnected)
      return false;
    this.headingPending = false;
    heading.focus();
    return true;
  }

  close(scope: string, enabled: boolean, fallback: FocusTarget | null) {
    const selection = this.selection;
    this.dismiss();
    if (!enabled || selection?.scope !== scope) return false;
    const opener = this.controls.get(scope)?.get(selection.id)?.target;
    const target = opener?.isConnected ? opener : fallback;
    if (!target?.isConnected) return false;
    target.focus();
    return true;
  }

  dismiss() {
    this.selection = null;
    this.headingPending = false;
  }

  reset() {
    this.dismiss();
    this.controls.clear();
  }
}
