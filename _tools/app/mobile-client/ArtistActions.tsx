import {useState} from 'react';
import {artistActionDefs,bindSheetItems} from '../src/shared/contextActions';
import {ActionSheet} from './ActionSheet';
import {BottomSheet} from './BottomSheet';
import {Button,Field,TextInput} from './ui';
import {Cover} from './CoverGroup';
import {PhotoIcon} from '@heroicons/react/24/outline';
import {commitArtistEdit,type ArtistEditAction} from './artistEditOutbox';
import {artistName,assetsFromIds,type LibraryArtist} from './artistsModel';
import {errorText} from './transport';
import {useAndroidBack} from './cards/useAndroidBack';

/** 이름 바꾸기 for an artist: an empty name returns to the source name. `save` may throw; the message stays on the sheet. */
export function ArtistRenameSheet({artist,onSave,onClose}:{artist:LibraryArtist;onSave(name:string):void;onClose():void}) {
  const [name,setName]=useState(artist.displayName??''),[error,setError]=useState('');
  useAndroidBack(onClose);
  return <BottomSheet title="이름 바꾸기" onClose={onClose}>
    <form className="artist-rename" onSubmit={event=>{event.preventDefault();try{onSave(name);}catch(reason){setError(errorText(reason));}}}>
      <Field label="작가 이름"><TextInput autoFocus value={name} placeholder={artist.sourceName??artist.label}
        onChange={event=>setName(event.target.value)} onKeyDown={event=>{
          if(event.key==='Enter'&&(event.nativeEvent.isComposing||event.keyCode===229))event.preventDefault();
        }}/></Field>
      <p className="hint">비워 두면 원래 이름을 사용합니다. 최대 120자</p>
      <Button type="submit">저장</Button>
    </form>
    {error&&<p className="error-message" role="alert">{error}</p>}
  </BottomSheet>;
}

/**
 * The long-press sheet of an artist: the shared artist list minus 다른 작가와 합치기 (PC only). The edits
 * go to the same queue as the artist page's menu; a failure to queue one stays on the sheet.
 */
export function ArtistActionSheet({artist,endpoint,onClose}:{artist:LibraryArtist;endpoint:string;onClose():void}) {
  const [renaming,setRenaming]=useState(false),[error,setError]=useState('');
  const edit=(action:ArtistEditAction,name?:string|null)=>{
    try{commitArtistEdit(endpoint,artist,action,name);onClose();}
    catch(reason){setError(errorText(reason));}
  };
  if(renaming)return <ArtistRenameSheet artist={artist} onSave={name=>{commitArtistEdit(endpoint,artist,'rename',name);onClose();}} onClose={onClose}/>;
  const items=bindSheetItems(artistActionDefs({pinned:artist.pinned,hidden:artist.hidden}),{
    pin:()=>edit(artist.pinned?'unpin':'pin'),
    rename:()=>setRenaming(true),
    hide:()=>edit(artist.hidden?'unhide':'hide'),
  });
  const cover=assetsFromIds(artist.coverAssetIds,artist.coverContentRatings)[0];
  const meta=['작가',`${artist.assetCount.toLocaleString('ko-KR')}장`].join(' · ');
  return <ActionSheet onClose={onClose} onChoose={()=>setError('')} notice={error} items={items}
    target={{name:artistName(artist),meta,thumb:cover?<Cover asset={cover} paused={false}/>:<PhotoIcon aria-hidden="true"/>,...(cover?{}:{color:'var(--color-muted)'})}}/>;
}
