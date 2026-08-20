function markdownToHtml(md) {
  if (!md) return '';
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // extract code blocks
  const codes = [];
  html = html.replace(/`([^`]+)`/g, (match, p1) => {
    codes.push(p1);
    return `__CODE_${codes.length - 1}__`;
  });

  html = html.replace(/\*([^*]+)\*/g, '<b>$1</b>');
  // Only match _ if preceded by whitespace/start/punctuation and followed by non-space, etc...
  // Actually, if we just extracted code blocks, does R_100 still have an underscore? Yes.
  // If we just use \b_([^_]+)_\b? No, _ is considered a word character in \b.
  // Let's match _ only if it's at a word boundary? No, \b_ means between \w and \W.
  // Let's match (?:^|\W)_([^_]+)_(?!\w)
  html = html.replace(/(^|\W)_([^_]+)_(?!\w)/g, '$1<i>$2</i>');
  
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // restore code blocks
  html = html.replace(/__CODE_(\d+)__/g, (match, p1) => {
    return `<code>${codes[p1]}</code>`;
  });

  return html;
}

console.log(markdownToHtml("• *R_100* | Contract: `CON_12345`\n  └ Handshake: `100ms` | Buy: `120ms`\n  └ Time: _12:00:00 UTC_"));
