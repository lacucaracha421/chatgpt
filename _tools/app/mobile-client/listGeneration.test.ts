import {afterEach, describe, expect, it, vi} from 'vitest';
import {fetchAssetFilterVersion, fetchListGeneration} from './listGeneration';
import {setOutboxConnection} from './outboxConnection';

afterEach(() => {delete window.LakomicsNative; setOutboxConnection(null);});

function bridge() {
  const calls:{id:string;path:string;connection?:string}[]=[];
  const cancel=vi.fn();
  window.LakomicsNative={request:(id,op,payload)=>{
    expect(op).toBe('api'); calls.push({id,...JSON.parse(payload)});
  },cancel};
  const reply=(index:number,generation='a'.repeat(64))=>window.dispatchEvent(new CustomEvent('lakomics-native',{
    detail:{id:calls[index].id,ok:true,data:{generation,filterVersion:1}},
  }));
  return {calls,cancel,reply};
}

describe('shared generation reads',()=>{
  it('issues one bridge read for concurrent startup generation and filter consumers',async()=>{
    setOutboxConnection('https://a.example');
    const {calls,reply}=bridge();
    const generation=fetchListGeneration(),filters=fetchAssetFilterVersion();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({path:'/v1/library/list-generation',connection:'https://a.example'});
    reply(0);
    expect(await generation).toBe('a'.repeat(64));expect(await filters).toBe(1);
    const fresh=fetchListGeneration();expect(calls).toHaveLength(2);
    reply(1,'b'.repeat(64));expect(await fresh).toBe('b'.repeat(64));
  });

  it('drops a cancelled owner while the remaining consumer keeps the same bridge request',async()=>{
    const {calls,cancel,reply}=bridge();
    const controller=new AbortController();
    const old=fetchListGeneration(controller.signal).catch(reason=>reason.name);
    const filters=fetchAssetFilterVersion();
    controller.abort();expect(await old).toBe('AbortError');expect(cancel).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);reply(0);expect(await filters).toBe(1);
  });

  it('cancels an abandoned bridge request and never reuses it for a new owner',async()=>{
    const {calls,cancel,reply}=bridge();
    const controller=new AbortController();
    const old=fetchListGeneration(controller.signal).catch(reason=>reason.name);
    controller.abort();
    const fresh=fetchListGeneration();
    expect(await old).toBe('AbortError');expect(cancel).toHaveBeenCalledWith(calls[0].id);
    expect(calls).toHaveLength(2);reply(0);reply(1,'b'.repeat(64));expect(await fresh).toBe('b'.repeat(64));
  });

  it('keeps different connection identities in separate native reads',async()=>{
    const {calls,reply}=bridge();
    setOutboxConnection('https://a.example');const old=fetchListGeneration();
    setOutboxConnection('https://b.example');const current=fetchAssetFilterVersion();
    expect(calls.map(call=>call.connection)).toEqual(['https://a.example','https://b.example']);
    reply(1);reply(0);expect(await current).toBe(1);expect(await old).toBe('a'.repeat(64));
  });
});
