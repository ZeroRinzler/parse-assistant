/** Latest-wins tag for a multi-step async method: only the newest run may write, and `cancel` retires the one in flight. */
export class LatestRun {
  private token = 0;

  begin(): number {
    return ++this.token;
  }

  cancel(): void {
    this.token++;
  }

  isCurrent(token: number): boolean {
    return token === this.token;
  }
}
