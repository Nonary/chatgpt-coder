class SerialOperationQueue {
  #tail = Promise.resolve();

  run(operation) {
    if (typeof operation !== 'function') throw new TypeError('A queued operation must be a function.');
    const result = this.#tail.catch(() => {}).then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }
}

module.exports = { SerialOperationQueue };
