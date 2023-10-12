export function isPlaylistM3U8(lines: string[]): boolean {
    const listOfKeywords: string[] = ["#EXT-X-STREAM-INF", "#EXT-X-I-FRAME-STREAM-INF"];
    let isPlaylistM3U8: boolean = false;

    for (let i = 0; i < lines.length && i < 10; i++) {
        for (let j = 0; j < listOfKeywords.length; j++) {
            if (lines[i].toUpperCase().includes(listOfKeywords[j])) {
                isPlaylistM3U8 = true;
                break;
            }
        }

        if (isPlaylistM3U8) {
            break;
        }
    }

    return isPlaylistM3U8;
}