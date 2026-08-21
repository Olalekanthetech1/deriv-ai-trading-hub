const html1 = `🤖 *AI IS ANALYZING THE MARKET*\n_Establishing secure connection..._\n\n📡 TERMINAL: Connecting to broker... ⏳`;
let html = html1;
html = html.replace(/\*([^*]+)\*/g, '<b>$1</b>');
html = html.replace(/(^|\W)_([^_]+)_(?!\w)/g, '$1<i>$2</i>');
console.log(html);
