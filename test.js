
import Hls2Mp4 from "./dist/index.js";
 async function testParse() {
     let hlsToMp4 = new Hls2Mp4({tsDownloadConcurrency: 5, maxRetry: 10}, (type, progress) => {
         console.info(type)
         console.info(progress)
     });
      await hlsToMp4.downloadM3u8("https://proxy.anistreme.live/proxy/m3u8/https%3A%2F%2Fwww009.vipanicdn.net%2Fstreamhls%2F0b594d900f47daabc194844092384914%2Fep.1.1677592419.m3u8");

 }
 testParse();