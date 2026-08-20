const fs = require('fs');
const files = [
  'lib/alert-email-dispatcher.ts',
  'lib/telegram-trade-controller.ts',
  'lib/telegram-admin-controller.ts',
  'lib/telegram-telemetry-alert-engine.ts'
];

const newFunc = `function markdownToHtml(md: string): string {
  if (!md) return '';
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const codes: string[] = [];
  html = html.replace(/\`([^\`]+)\`/g, (match, p1) => {
    codes.push(p1);
    return \`__CODE_\${codes.length - 1}__\`;
  });

  const links: {text: string, url: string}[] = [];
  html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, (match, p1, p2) => {
    links.push({text: p1, url: p2});
    return \`__LINK_\${links.length - 1}__\`;
  });

  html = html.replace(/\\*([^*]+)\\*/g, '<b>$1</b>');
  html = html.replace(/(^|\\W)_([^_]+)_(?!\\w)/g, '$1<i>$2</i>');

  html = html.replace(/__LINK_(\\d+)__/g, (match, p1) => {
    const link = links[parseInt(p1, 10)];
    return \`<a href="\${link.url}">\${link.text}</a>\`;
  });

  html = html.replace(/__CODE_(\\d+)__/g, (match, p1) => {
    return \`<code>\${codes[parseInt(p1, 10)]}</code>\`;
  });

  return html;
}`;

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  const regex = /function markdownToHtml\(md: string\): string \{[\s\S]*?return html;\n\}/;
  content = content.replace(regex, newFunc);
  fs.writeFileSync(file, content);
}
console.log("Done");
