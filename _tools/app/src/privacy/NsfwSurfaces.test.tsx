import {cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {PrivacyProvider} from './PrivacyContext';
import {AssetImage} from './AssetImage';
import {VideoPlayer} from '../video/VideoPlayer';
import {ArtistCollage} from '../artists/ArtistCollage';
import {HomeRevisit} from '../home/HomeRevisit';
import type {LibraryGateway,AssetSummary} from '../library/types';
afterEach(cleanup);
const ratings={g:'g',s:'s',q:'q',e:'e',u:null} as const;
const refreshAssets=vi.fn(async(_query:unknown,ids:string[])=>ids.map(id=>({id,contentRating:ratings[id as keyof typeof ratings]}) as AssetSummary));
const gateway={refreshAssets,getRevisitSlate:vi.fn(async()=>({bundles:[{kind:'date',assetIds:Object.keys(ratings)}]}))} as unknown as LibraryGateway;
it('batches mosaic, home and preview summary reads and reveals only individual g cells',async()=>{
 refreshAssets.mockClear();
 const {container,rerender}=render(<PrivacyProvider gateway={gateway} privacyMode={false} setPrivacyMode={vi.fn()} nsfwFilter>
  <ArtistCollage assetIds={['g','s','u']} privacyMode={false}/>
  <HomeRevisit gateway={gateway} localDate="2026-10-03" privacyMode={false}/>
  <AssetImage src="http://lakomics.localhost/thumbnail/e"/>
 </PrivacyProvider>);
 expect(container.querySelector('img[src]')).toBeNull();
 await waitFor(()=>expect(container.querySelectorAll('img[src]')).toHaveLength(2));
 expect([...container.querySelectorAll('img[src]')].every(img=>img.getAttribute('src')?.endsWith('/g'))).toBe(true);
 expect(refreshAssets.mock.calls.flatMap(call=>call[1])).toEqual(expect.arrayContaining(['g','s','u','e','q']));
 expect(refreshAssets.mock.calls.length).toBeLessThan(5);
 expect(container.querySelectorAll('.artist-collage__cell')).toHaveLength(3);
 expect(container.querySelectorAll('.home-revisit__cell')).toHaveLength(5);
 rerender(<PrivacyProvider gateway={gateway} privacyMode setPrivacyMode={vi.fn()} nsfwFilter><ArtistCollage assetIds={['g','s','u']} privacyMode={false}/></PrivacyProvider>);
 expect(container.querySelector('img[src]')).toBeNull();
});
it('unknown ratings stay masked without a gateway and external work covers stay outside the filter',()=>{
 const {container}=render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()} nsfwFilter><AssetImage src="http://lakomics.localhost/thumbnail/unknown"/><AssetImage src="http://lakomics.localhost/work-artwork/work"/></PrivacyProvider>);
 expect(container.querySelector('img[src*="thumbnail"]')).toBeNull();expect(container.querySelector('img[src*="work-artwork"]')).toBeTruthy();
});
it('uses a supplied summary immediately and does not query a known safe cover again',()=>{
 refreshAssets.mockClear();
 const {container}=render(<PrivacyProvider gateway={gateway} privacyMode={false} setPrivacyMode={vi.fn()} nsfwFilter><AssetImage asset={{contentRating:'g'}} src="http://lakomics.localhost/thumbnail/g"/><AssetImage asset={{contentRating:'e'}} src="http://lakomics.localhost/thumbnail/e"/></PrivacyProvider>);
 expect(container.querySelectorAll('img[src]')).toHaveLength(1);expect(refreshAssets).not.toHaveBeenCalled();
});

it('does not load safe-rated video previews from summaries or ID-only covers',async()=>{
 const video={id:'video',contentRating:'g',media:{kind:'video'}} as AssetSummary;
 const refresh=vi.fn(async()=>[video]);
 const {container}=render(<PrivacyProvider gateway={{refreshAssets:refresh}} privacyMode={false} setPrivacyMode={vi.fn()} nsfwFilter>
  <AssetImage asset={video} src="http://lakomics.localhost/thumbnail/video"/>
  <AssetImage src="http://lakomics.localhost/thumbnail/video"/>
 </PrivacyProvider>);
 await waitFor(()=>expect(refresh).toHaveBeenCalledOnce());
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(container.querySelector('img[src]')).toBeNull();
});

it('blocks safe-rated video playback before its player mounts',()=>{
 const resolve=vi.fn();
 const {container}=render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()} nsfwFilter>
  <VideoPlayer asset={{id:'video',originalName:'video.mp4',contentRating:'g',media:{durationMs:1000,scrubFrameCount:0}}} resolvePlaybackUrl={resolve} poster="http://lakomics.localhost/thumbnail/video"/>
 </PrivacyProvider>);
 expect(container.querySelector('video')).toBeNull();expect(container.querySelector('img')).toBeNull();
 expect(resolve).not.toHaveBeenCalled();
});
