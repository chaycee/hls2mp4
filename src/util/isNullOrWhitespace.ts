export function isNullOrWhitespace(input: string | null | undefined): boolean {
    return !input || input.trim() === '';
}