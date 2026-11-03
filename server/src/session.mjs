// The last real play session, so the status page has something true to show when nobody is playing.
//
// A session starts when the first player joins and ends once the field has been empty for a
// while (a quick refresh or a deploy's reconnect shouldn't end it). While it runs, we keep the
// latest SLO numbers measured WITH players present; when it ends, those become "the last session".
// Nothing here is estimated or invented: it's the same measurements, kept with their date.

export const END_AFTER_EMPTY_MS = 60_000;

export class SessionTracker {
  constructor(saved = null) {
    this.current = null;
    this.emptySince = null;
    this.last = saved && typeof saved.endedAt === "number" ? saved : null;
  }

  // Called every few seconds: players online now, rounds started so far, and the SLO report.
  update(now, online, roundsTotal, report) {
    if (online > 0) {
      this.emptySince = null;
      if (!this.current) this.current = { startedAt: now, peakPlayers: 0, roundsAtStart: roundsTotal };
      this.current.peakPlayers = Math.max(this.current.peakPlayers, online);
      this.current.rounds = roundsTotal - this.current.roundsAtStart;
      // Only keep numbers that were actually judged (enough samples), so the summary never shows
      // a verdict the live page wouldn't have given.
      const judged = report.filter((s) => s.met !== null);
      if (judged.length) this.current.slos = judged.map(({ id, name, percentile, targetMs, samples, met, p50, p95, p99 }) => ({ id, name, percentile, targetMs, samples, met, value: { p50, p95, p99 }[percentile] }));
      return;
    }
    if (!this.current) return;
    this.emptySince ??= now;
    if (now - this.emptySince < END_AFTER_EMPTY_MS) return;
    // The field has been empty long enough: the session is over.
    const { startedAt, peakPlayers, rounds = 0, slos } = this.current;
    if (slos) this.last = { startedAt, endedAt: this.emptySince, peakPlayers, rounds, slos };
    this.current = null;
    this.emptySince = null;
  }

  toJSON() {
    return this.last;
  }
}
