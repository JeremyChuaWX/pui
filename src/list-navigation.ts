export function cycleIndex(index: number, delta: -1 | 1, itemCount: number): number {
    if (itemCount <= 0) return 0;
    return (((index + delta) % itemCount) + itemCount) % itemCount;
}
