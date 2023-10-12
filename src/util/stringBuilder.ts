export class StringBuilder {
    private buffer: string[] = [];

    append(str: string): void {
        this.buffer.push(str);
    }

    clear(): void {
        this.buffer = [];
    }

    toString(): string {
        return this.buffer.join('');
    }
}