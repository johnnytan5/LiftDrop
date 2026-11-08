// Echo gate: the browser speaker feeds the mic, so mic audio is held back
// while the agent speaks (and briefly after, for the speaker tail) or the
// transcriber would hear the agent as the guest.
const TAIL_MS = 300;

export class Gate {
  clock: () => number;
  speaking = false;
  endedAt = -Infinity;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  start(): void {
    this.speaking = true;
  }

  end(): void {
    this.speaking = false;
    this.endedAt = this.clock();
  }

  shouldSend(): boolean {
    return !this.speaking && this.clock() - this.endedAt > TAIL_MS;
  }
}
