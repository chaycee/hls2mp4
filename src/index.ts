import Transmuxer from './muxer/mp4-transmuxer'
import aesjs,  {ByteSource} from 'aes-js'
import {fetchFile} from './util/http'
import {isPlaylistM3U8} from "./util/isPlaylistM3U8";
import {isNullOrWhitespace} from "./util/isNullOrWhitespace";
import {StringBuilder} from "./util/stringBuilder";
import * as http from "http";

enum TaskType {
    parseM3u8 = 0,
    downloadTs = 1,
    mergeTs = 2
}

export interface ProgressCallback {
    (type: TaskType, progress: number): void
}

export type OutputType = 'mp4' | 'ts'

export type Hls2Mp4Options = {
    /**
     * max retry times while request data failed, default: 3
     */
    maxRetry?: number;
    /**
     * the concurrency for download ts segment, default: 10
     */
    tsDownloadConcurrency?: number;
    /**
     * the type of output file, can be mp4 or ts, default: mp4
     */
    outputType?: OutputType;
}

type LoadResult<T = unknown> = {
    done: boolean;
    data?: T;
    msg?: string;
}

type Segment = {
    index: number;
    url: string;
}

export interface M3u8Parsed {
    url: string;
    content: string;
}

type SegmentGroup = {
    key?: string;
    iv?: string;
    segments: string[];
}

function createFileUrlRegExp(ext: string, flags?: string) {
    return new RegExp('(https?://)?[\\w:\\.\\-\\/]+?\\.' + ext, flags)
}

function parseUrl(url: string, path: string) {
    if (path.startsWith('http')) {
        return path;
    }
    return new URL(path, url).href;
}

const mimeType = <Record<OutputType, string>>{
    mp4: 'video/mp4',
    ts: 'video/mp2t'
}

class Hls2Mp4 {

    private maxRetry: number;
    private loadRetryTime = 0;
    private outputType: OutputType;
    private onProgress?: ProgressCallback;
    private tsDownloadConcurrency: number;
    private totalSegments = 0;
    private duration = 0;
    private savedSegments = new Map<number, Uint8Array>()
    public static version = '2.0.5';
    public static TaskType = TaskType;

    constructor({ maxRetry = 3, tsDownloadConcurrency = 10, outputType = 'mp4' }: Hls2Mp4Options, onProgress?: ProgressCallback) {
        this.maxRetry = maxRetry;
        this.tsDownloadConcurrency = tsDownloadConcurrency;
        this.outputType = outputType;
        this.onProgress = onProgress;
    }

    private transformBuffer(buffer: Uint8Array) {
        if (buffer[0] === 0x47) {
            return buffer;
        }
        let bufferOffset = 0;
        for (let i = 0; i < buffer.length; i++) {

            if (buffer[i] === 0x47 && buffer[i + 1] === 0x40) {
                bufferOffset = i;
                break;
            }
        }
        return buffer.slice(bufferOffset)
    }

    private hexToUint8Array(hex: string) {
        const matchedChars = hex.replace(/^0x/, '').match(
            /[\da-f]{2}/gi
        );
        if (matchedChars) {
            return new Uint8Array(
                matchedChars.map(hx => parseInt(hx, 16))
            )
        }
        return new Uint8Array(0);
    }

    private aesDecrypt(buffer: Uint8Array, keyBuffer: Uint8Array, iv?: string) {
        let ivData: ByteSource;
        if (iv) {
            ivData = iv.startsWith('0x') ? this.hexToUint8Array(iv) : aesjs.utils.utf8.toBytes(iv)
        }
        const aesCbc = new aesjs.ModeOfOperation.cbc(keyBuffer, ivData!);
        return aesCbc.decrypt(buffer);
    }

    public static async parseM3u8File(url: string, customFetch?: (url: string) => Promise<string>): Promise<M3u8Parsed> {
        const uri = new URL(url);
        const baseUrl = `${uri.protocol}://${uri.host}`;
        const lastIndexSlash = url.lastIndexOf('/');
        const resolutionRegex = /RESOLUTION=\d+x(\d+)/;
        let playList = '';
        if (customFetch) {
            playList = await customFetch(url)
        }
        else {
            playList = await fetchFile(url).then(
                data => aesjs.utils.utf8.fromBytes(data)
            )
        }
        const lines: string[] = playList.split('\n');
        const isPlaylist = isPlaylistM3U8(lines);
        const newLineBuilder = new StringBuilder();
        if (isPlaylist) {
            const playListUrls: { url: string, resolution: number | null }[] = []
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line.startsWith("http") && !line.startsWith('#') && !isNullOrWhitespace(line)) {
                    newLineBuilder.clear();
                    if (line.startsWith("//")) {
                        newLineBuilder.append("https:" + line)
                    } else if (line.startsWith("/")) {
                        newLineBuilder.append(baseUrl);
                        newLineBuilder.append(line);
                    } else {
                        const slicedUrl = url.slice(0, lastIndexSlash + 1);
                        newLineBuilder.append(slicedUrl);
                        newLineBuilder.append(line);
                    }
                    const match = lines[i - 1].match(resolutionRegex)?.at(1);
                    const lastNumber = match ? parseInt(match) : null;
                    playListUrls.push({
                        url: newLineBuilder.toString(),
                        resolution: lastNumber
                    });
                }else if(line.startsWith("http")){
                    const match = lines[i - 1].match(resolutionRegex)?.at(1);
                    const lastNumber = match ? parseInt(match) : null;
                    playListUrls.push({
                        url: lines[i],
                        resolution: lastNumber
                    });
                }
            }
            const nonNullItems = playListUrls.filter(item => item.resolution !== null);
            let highQualityUrl = playListUrls[0].url
            if (nonNullItems.length > 0) {
                highQualityUrl = nonNullItems.reduce((maxItem, currentItem) => {
                    return currentItem.resolution! > maxItem.resolution! ? currentItem : maxItem;
                }, nonNullItems[0]).url;
            }
            return this.parseM3u8File(highQualityUrl, customFetch)
        }
        return {
            url,
            content: playList
        }
    }

    private async parseM3u8(url: string) {
        this.onProgress?.(TaskType.parseM3u8, 0)
        const { done, data } = await this.loopLoadFile<M3u8Parsed>(
            () => Hls2Mp4.parseM3u8File(url)
        )
        if (done) {
            this.onProgress?.(TaskType.parseM3u8, 1)
            return data;
        }
        throw new Error('m3u8 load failed')
    }

    private async downloadFile(url: string) {
        const { done, data } = await this.loopLoadFile<Uint8Array>(
            () => fetchFile(url)
        )
        if (done) {
            return data;
        }
        const fileName = url.match(/\w+\.\w{2,3}$/i)?.[0]
        throw new Error(`load file ${fileName} error after retry ${this.maxRetry} times.`)
    }

    private async downloadSegments(segs: Segment[], key?: Uint8Array, iv?: string) {
        return Promise.all(
            segs.map(async ({ index, url }) => {
                const tsData = await this.downloadFile(url)
                const buffer = key ? this.aesDecrypt(tsData!, key, iv) : this.transformBuffer(tsData!)
                this.savedSegments.set(index, buffer)
                this.onProgress?.(TaskType.downloadTs, this.savedSegments.size / this.totalSegments)
            })
        )
    }

    private computeTotalDuration(content: string) {
        let duration = 0;
        const tags = content.match(/#EXTINF:\d+(.\d+)?/gi)
        tags?.forEach(
            tag => {
                const dur = tag.match(/\d+(.\d+)?/)
                if (dur) {
                    duration += Number(dur[0]);
                }
            }
        )
        return duration;
    }

    private async downloadM3u8(url: string) {

        const m3u8Parsed = await this.parseM3u8(url)
        let { content, url: parsedUrl } = m3u8Parsed!;
        const URIRegex = new RegExp(`URI=""([^""]+)""`)

        const urls = this.getUrls(url,content);
        if (!urls) {
            throw new Error('Invalid m3u8 file, no ts file found')
        }
        this.duration = this.computeTotalDuration(content)

        const segments: SegmentGroup[] = []
        for (let i = 0; i < urls.length; i++) {
            const uri = new URL(url);
            const baseUrl = `${uri.protocol}://${uri.host}`;
            const lastIndexSlash = url.lastIndexOf('/');
            const matched = urls[i].url
            let matchedKey:string|undefined;
            if (matched.match(/#EXT-X-KEY/)) {
                const matchedUrl = matched.match(URIRegex)?.at(1);
                if(matchedUrl){
                    if(matchedUrl.startsWith("//")){
                        matchedKey = "https:"+matchedUrl;
                    }else if(matchedUrl.startsWith("/")){
                        matchedKey = baseUrl+matchedUrl;
                    }else if(matchedUrl.startsWith("http")){
                        matchedKey = matchedUrl;
                    }else{
                        const slicedUrl = url.slice(0, lastIndexSlash + 1);
                        matchedKey = slicedUrl+matchedUrl;
                    }
                }
                const matchedIV = matched.match(/IV=\w+$/)?.[0]?.replace(/^IV=/, '')
                segments.push({
                    key: matchedKey,
                    iv: matchedIV,
                    segments: []
                })
            }
            else if (i === 0) {
                segments.push({
                    segments: [matched]
                })
            }
            else {
                segments[segments.length - 1].segments.push(matched)
            }
        }

        this.totalSegments = segments.reduce((prev, current) => prev + current.segments.length, 0);
        const batch = this.tsDownloadConcurrency;
        let treatedSegments = 0;

        for (const group of segments) {
            const total = group.segments.length;
            let keyBuffer: Uint8Array | undefined;

            if (group.key) {
                keyBuffer = await this.downloadFile(group.key)
            }
            for (let i = 0; i <= Math.floor((total / batch)); i++) {
                await this.downloadSegments(
                    group.segments.slice(
                        i * batch,
                        Math.min(total, (i + 1) * batch)
                    ).map<Segment>(
                        (seg, j) => {
                            return {
                                index: treatedSegments + i * batch + j,
                                url:seg
                            }
                        }
                    ),
                    keyBuffer,
                    group.iv
                )
            }
            treatedSegments += total;
        }
    }

    private getUrls(url: string, content: string) {
        const uri = new URL(url);
        const baseUrl = `${uri.protocol}://${uri.host}`;
        const lastIndexSlash = url.lastIndexOf('/');
        const lines: string[] = content.split('\n');
        const newLineBuilder = new StringBuilder();
        const finalUrls: { url: string, type: "ts" | "encryption" | null }[] = []
        for (let i = 0; i < lines.length; i++) {

            const line = lines[i];
            if (line.startsWith("#EXT-X-KEY")) {
                finalUrls.push({
                    url: line,
                    type: 'encryption'
                });
            }
            if (!line.startsWith("http") && !line.startsWith('#') && !isNullOrWhitespace(line)) {
                newLineBuilder.clear();
                if (line.startsWith("//")) {
                    newLineBuilder.append("https:" + line)
                } else if (line.startsWith("/")) {
                    newLineBuilder.append(baseUrl);
                    newLineBuilder.append(line);
                } else {
                    const slicedUrl = url.slice(0, lastIndexSlash + 1);
                    newLineBuilder.append(slicedUrl);
                    newLineBuilder.append(line);
                }
                finalUrls.push({
                    url: newLineBuilder.toString(),
                    type: "ts"
                })
            }else if (line.startsWith("http")){
                finalUrls.push({
                    url: line,
                    type: "ts"
                })
            }
        }
        return finalUrls;
    }

    private async loopLoadFile<T = undefined>(startLoad: () => PromiseLike<T | undefined>): Promise<LoadResult<T>> {
        try {
            const result = await startLoad();
            this.loadRetryTime = 0;
            return {
                done: true,
                data: result
            }
        }
        catch (err) {
            this.loadRetryTime += 1;
            if (this.loadRetryTime < this.maxRetry) {
                return this.loopLoadFile<T>(startLoad)
            }
            return {
                done: false,
                data: undefined
            }
        }
    }

    private mergeDataArray(data: Uint8Array[]) {

        const totalByteLength = data.reduce(
            (prev, current) => prev + current.byteLength,
            0
        )
        const dataArray = new Uint8Array(totalByteLength)
        let byteOffset = 0;

        for (const part of data) {
            dataArray.set(part, byteOffset)
            byteOffset += part.byteLength
        }

        return dataArray
    }

    private async loopSegments(
        transformer?: (data: Uint8Array, index: number) => Uint8Array | PromiseLike<Uint8Array>
    ) {

        const chunks: Uint8Array[] = []

        for (let i = 0; i < this.savedSegments.size; i++) {

            let chunk = this.savedSegments.get(i)

            if (chunk) {
                if (transformer) {
                    chunk = await transformer(chunk, i)
                }
                chunks.push(chunk);
            }
        }
        return chunks
    }

    private async transmuxerSegments() {

        const transmuxer = new Transmuxer({
            duration: this.duration
        })

        const transmuxerFirstSegment = (data: Uint8Array) => {
            return new Promise<Uint8Array>(
                (resolve) => {
                    transmuxer.on('data', (segment) => {
                        const data = new Uint8Array(segment.initSegment.byteLength + segment.data.byteLength);
                        data.set(segment.initSegment, 0);
                        data.set(segment.data, segment.initSegment.byteLength);
                        resolve(data);
                    })
                    transmuxer.push(data)
                    transmuxer.flush()
                }
            )
        }

        const transmuxerSegment = (buffer: Uint8Array) => {
            return new Promise<Uint8Array>(
                (resolve) => {
                    transmuxer.off('data')
                    transmuxer.on('data', (segment) => resolve(segment.data))
                    transmuxer.push(buffer)
                    transmuxer.flush()
                }
            )
        }

        const chunks = await this.loopSegments(
            async (chunk, index) => {
                if (index === 0) {
                    return transmuxerFirstSegment(chunk)
                }
                else {
                    return transmuxerSegment(chunk)
                }
            }
        )

        return this.mergeDataArray(chunks)
    }

    public async download(url: string) {
        await this.downloadM3u8(url);
        this.onProgress?.(TaskType.mergeTs, 0);
        let data: Uint8Array;
        if (this.outputType === 'mp4') {
            data = await this.transmuxerSegments()
        }
        else {
            const chunks = await this.loopSegments()
            data = this.mergeDataArray(chunks)
        }
        this.onProgress?.(TaskType.mergeTs, 1);
        return data;
    }

    public saveToFile(buffer: ArrayBufferLike, filename: string) {
        const type = mimeType[this.outputType];
        const objectUrl = URL.createObjectURL(new Blob([buffer], { type }));
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = `${filename}.${this.outputType}`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
    }
}

export default Hls2Mp4;