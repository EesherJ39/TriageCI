export class BoundedQueue<T> {
  readonly capacity: number;
  #items: T[] = [];
  #waiters: Array<(value: T | null) => void> = [];
  #closed = false;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be positive");
    this.capacity = capacity;
  }

  get depth(): number {
    return this.#items.length;
  }

  tryPush(item: T): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(item);
      return true;
    }
    if (this.#items.length >= this.capacity) return false;
    this.#items.push(item);
    return true;
  }

  async pop(): Promise<T | null> {
    const item = this.#items.shift();
    if (item !== undefined) return item;
    if (this.#closed) return null;
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(null);
  }
}
