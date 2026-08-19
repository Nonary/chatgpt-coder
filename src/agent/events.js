const MAX_BUFFERED_EVENTS = 500;

class EventLog {
  constructor({ maxEvents = MAX_BUFFERED_EVENTS } = {}) {
    this.maxEvents = maxEvents;
    this.events = [];
    this.sequence = 0;
    this.waiters = new Set();
  }

  emit(payload) {
    if (!payload || typeof payload !== 'object') return null;
    this.sequence += 1;
    const event = { ...payload, seq: this.sequence, at: new Date().toISOString() };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.resolve([event]);
    }
    return event;
  }

  since(sequence) {
    const from = Number.isFinite(sequence) ? sequence : 0;
    return this.events.filter((event) => event.seq > from);
  }

  // The page long-polls instead of using SSE so that every transport - including
  // GM_xmlhttpRequest and the popup bridge - behaves identically.
  async wait(sequence, timeoutMilliseconds = 25_000) {
    const pending = this.since(sequence);
    if (pending.length > 0) return pending;
    return new Promise((resolve) => {
      const waiter = { resolve };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve([]);
      }, timeoutMilliseconds);
      timer.unref?.();
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.add(waiter);
    });
  }

  close() {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.resolve([]);
    }
  }
}

module.exports = { EventLog, MAX_BUFFERED_EVENTS };
