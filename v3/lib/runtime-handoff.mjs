export class RuntimeHandoffGate {
  constructor() {
    this.phase = 'idle';
    this.retiringReception = null;
  }

  get blocked() {
    return this.phase !== 'idle';
  }

  begin() {
    this.phase = 'classifying';
    this.retiringReception = null;
  }

  waitForReceptionReplacement(retiringReception = null) {
    this.phase = 'waiting-reception';
    this.retiringReception = retiringReception;
  }

  observeReceptionReady(reception, snapshot = {}) {
    if (
      this.phase !== 'waiting-reception'
      || !snapshot.ready
      || !reception
      || reception === this.retiringReception
      || reception.intentionalRestart
    ) {
      return false;
    }
    this.release();
    return true;
  }

  release() {
    this.phase = 'idle';
    this.retiringReception = null;
  }
}
