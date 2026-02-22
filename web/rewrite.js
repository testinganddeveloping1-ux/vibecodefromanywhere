const fs = require('fs');
let content = fs.readFileSync('/home/archu/Documents/Coding/coding-fromyour-phone/web/src/ui/components/WrapperChatView.tsx', 'utf8');

const replacements = {
  'wrapChat': 'chat',
  'wrapToolbarLeft': 'toolbarLeft',
  'wrapToolbarRight': 'toolbarRight',
  'wrapToolbar': 'toolbar',
  'wrapModes': 'modes',
  'wrapModeBtnOn': 'modeBtnOn',
  'wrapModeBtn': 'modeBtn',
  'wrapSessionBadge': 'sessionBadge',
  'wrapStats': 'stats',
  'wrapStatOn': 'statOn',
  'wrapStatErr': 'statErr',
  'wrapStat': 'stat',
  'wrapRefreshBtn': 'refreshBtn',
  'wrapCwd': 'cwd',
  'wrapError': 'error',
  'wrapFeed': 'feed',
  'wrapEmpty': 'empty',
  'wrapSysEvent': 'sysEvent',
  'wrapMsgBubbleUser': 'msgBubbleUser',
  'wrapMsgBubble': 'msgBubble',
  'wrapMsgText': 'msgText',
  'wrapMsgTime': 'msgTime',
  'wrapMsgUser': 'msgUser',
  'wrapMsgAssistant': 'msgAssistant',
  'wrapMsg': 'msg',
  'wrapThinkHeadLeft': 'thinkHeadLeft',
  'wrapThinkHeadStatic': 'thinkHeadStatic',
  'wrapThinkHead': 'thinkHead',
  'wrapThinkLabel': 'thinkLabel',
  'wrapThinkPreview': 'thinkPreview',
  'wrapThinkBody': 'thinkBody',
  'wrapThinkLive': 'thinkLive',
  'wrapThink': 'think',
  'wrapToolHeadLeft': 'toolHeadLeft',
  'wrapToolHeadRight': 'toolHeadRight',
  'wrapToolIcon': 'toolIcon',
  'wrapToolMain': 'toolMain',
  'wrapToolTop': 'toolTop',
  'wrapToolLabel': 'toolLabel',
  'wrapToolName': 'toolName',
  'wrapToolCallId': 'toolCallId',
  'wrapToolCmd': 'toolCmd',
  'wrapToolBody': 'toolBody',
  'wrapToolStateCard--': 'toolStateCard--',
  'wrapToolStateCard': 'toolStateCard',
  'wrapToolStatic': 'toolStatic',
  'wrapTool': 'tool',
  'wrapInlineResultHead': 'inlineResultHead',
  'wrapInlineResultLabel': 'inlineResultLabel',
  'wrapInlineResultMeta': 'inlineResultMeta',
  'wrapInlineResultText': 'inlineResultText',
  'wrapInlineResult--': 'inlineResult--',
  'wrapInlineResult': 'inlineResult',
  'wrapInlinePending': 'inlinePending',
  'wrapRawSummary': 'rawSummary',
  'wrapRaw': 'raw',
  'wrapResultLabel': 'resultLabel',
  'wrapResultPreview': 'resultPreview',
  'wrapResultBody': 'resultBody',
  'wrapResultText': 'resultText',
  'wrapResultHead': 'toolHead',
  'wrapResult--': 'result--',
  'wrapResult': 'result',
  'wrapTypingBubbleStale': 'typingBubbleStale',
  'wrapTypingBubble': 'typingBubble',
  'wrapTypingHint': 'typingHint',
  'wrapTypingDots': 'typingDots',
  'wrapTypingDot': 'typingDot',
  'wrapTypingRow': 'typingRow'
};

content = `import styles from "./WrapperChatView.module.css";\n` + content;

// Replace class attributes
content = content.replace(/className="([^"]+)"/g, (match, classNames) => {
  const parts = classNames.split(' ').map(c => {
    // Check if it's one of the exact string matches
    let modClass = c;
    for (const [key, val] of Object.entries(replacements)) {
      if (c === key || c.startsWith(key + '--')) {
        modClass = c.replace(key, val);
        break; // Stop after first match so we don't double replace
      }
    }
    // Return expression or literal string
    if (modClass !== c || replacements[c]) {
      return `\$\{styles.${modClass.replace(/--([a-z]+)/g, "['--$1']").replace(/--/g, '')}\}`;
    }
    if (['mono', 'loadingDots', 'dimText', 'liveDot', 'bashBlock', 'bashPrompt', 'toolSummaryText', 'toolField', 'toolFieldKey', 'toolFieldVal', 'orchCmdCard', 'orchCmdTitle', 'orchCmdMetaRow', 'orchCmdChip', 'orchCmdPath', 'orchCmdLine'].includes(c)) {
       return `\$\{styles.${c}\}`;
    }
    // unchanged
    return c;
  });
  
  // If it contains any ${}, it's dynamic
  if (parts.some(p => p.includes('${'))) {
    // If it's a mix of static and dynamic, we need to map the static ones to styles if they exist, but for now we'll assumes they are global or styles
    const resolved = parts.map(p => {
       if (p.includes('${')) return p;
       // Try matching static classes
       if (p === 'mono') return '${styles.mono}';
       return p; 
    }).join(' ');
    return `className={\`${resolved}\`}`;
  }
  
  return `className="${parts.join(' ')}"`;
});

// Dynamic classnames
content = content.replace(/className=\{`([^`]+)`\}/g, (match, inner) => {
   // Complex regex replacing, we'll just handle it directly
   let result = inner;
   for (const [key, val] of Object.entries(replacements)) {
       result = result.replace(new RegExp('\\b' + key + '\\b', 'g'), `\$\{styles.${val}\}`);
       result = result.replace(new RegExp('\\b' + key + '--([a-zA-Z]+)', 'g'), `\$\{styles['${val}--$1']\}`);
   }
   
   // Handle dynamic interpolations inside inner
   result = result.replace(/toolStateBadge--\$\{([^\}]+)\}/g, `\$\{styles[\`toolStateBadge--\$\{uid\}T\`].replace('uidT', $1)\}`);
   result = result.replace(/wrapToolStateCard--\$\{([^\}]+)\}/g, `\$\{styles[\`toolStateCard--\$\{uid\}T\`].replace('uidT', $1)\}`);
   result = result.replace(/wrapInlineResult--\$\{([^\}]+)\}/g, `\$\{styles[\`inlineResult--\$\{uid\}T\`].replace('uidT', $1)\}`);
   result = result.replace(/wrapResult--\$\{([^\}]+)\}/g, `\$\{styles[\`result--\$\{uid\}T\`].replace('uidT', $1)\}`);

   return `className={\`${result}\`}`;
});

// Manual cleanup of the replacement messes
content = content.replace("className={`wrapModeBtn ${mode === m ? \"wrapModeBtnOn\" : \"\"}`}", "className={`${styles.modeBtn} ${mode === m ? styles.modeBtnOn : \"\"}`}");
content = content.replace("className={`wrapStat mono ${stats.running > 0 ? \"wrapStatOn\" : \"\"}`}", "className={`${styles.stat} ${styles.mono} ${stats.running > 0 ? styles.statOn : \"\"}`}");
content = content.replace("className={`wrapThink ${isLive ? \"wrapThinkLive\" : \"\"}`}", "className={`${styles.think} ${isLive ? styles.thinkLive : \"\"}`}");
content = content.replace("className={`wrapTool wrapToolStatic wrapToolStateCard wrapToolStateCard--${state}`}", "className={`${styles.tool} ${styles.toolStatic} ${styles.toolStateCard} ${styles['toolStateCard--' + state]}`}");
content = content.replace("className={`wrapInlineResult wrapInlineResult--${state}`}", "className={`${styles.inlineResult} ${styles['inlineResult--' + state]}`}");
content = content.replace("className={`wrapResult wrapResult--${item.state}`}", "className={`${styles.result} ${styles['result--' + item.state]}`}");
content = content.replace("className={`toolStateBadge toolStateBadge--${state}`}", "className={`${styles.toolStateBadge} ${styles['toolStateBadge--' + state]}`}");
content = content.replace("className={`toolStateBadge toolStateBadge--${item.state}`}", "className={`${styles.toolStateBadge} ${styles['toolStateBadge--' + item.state]}`}");
content = content.replace("className={`wrapMsgBubble wrapTypingBubble ${typingStale ? \"wrapTypingBubbleStale\" : \"\"}`}", "className={`${styles.msgBubble} ${styles.typingBubble} ${typingStale ? styles.typingBubbleStale : \"\"}`}");

fs.writeFileSync('/home/archu/Documents/Coding/coding-fromyour-phone/web/src/ui/components/WrapperChatView.tsx', content, 'utf8');
