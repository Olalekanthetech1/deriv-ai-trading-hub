const html1 = `🤖 *AI IS ANALYZING THE MARKET*\n_Evaluating market anomalies..._\n\n📡 TERMINAL: Launched ✅\n📊 Data stream: Connected ✅\n🧠 AI analysis: Running multi-horizon ensemble... ⚙️`;
let html = html1;
html = html.replace(/\*([^*]+)\*/g, '<b>$1</b>');
html = html.replace(/(^|\W)_([^_]+)_(?!\w)/g, '$1<i>$2</i>');
console.log(html);
console.log(Buffer.byteLength(html, 'utf8'));
