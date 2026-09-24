import {QuestionMarkCircleIcon} from '@heroicons/react/24/outline';
import {useState} from 'react';
import {MARKDOWN_HELP_INTRO,MARKDOWN_HELP_TITLE,MarkdownHelpContent} from '../src/shared/markdown/MarkdownHelp';
import {Button,Dialog,DialogDescription,IconButton} from './ui';

/** Editor header button that opens the Markdown cheat sheet as this client's bottom sheet. */
export function MarkdownHelpButton() {
  const [open,setOpen]=useState(false);
  return <>
    <IconButton label={MARKDOWN_HELP_TITLE} icon={QuestionMarkCircleIcon} onClick={()=>setOpen(true)}/>
    {open&&<Dialog open title={MARKDOWN_HELP_TITLE} onClose={()=>setOpen(false)}>
      <div className="library-sheet">
        <DialogDescription className="markdown-help__intro">{MARKDOWN_HELP_INTRO}</DialogDescription>
        <MarkdownHelpContent/>
        <Button variant="ghost" onClick={()=>setOpen(false)}>닫기</Button>
      </div>
    </Dialog>}
  </>;
}
