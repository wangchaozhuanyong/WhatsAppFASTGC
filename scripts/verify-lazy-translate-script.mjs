// 校验 buildWaInstallLazyTranslateScript 注入文本是否语法可解析。
// 通过实际 eval 模板字面量得到 runtime 字符串，再用 vm.Script 校验语法。
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('index.html', 'utf8');
const tplMatch = src.match(/function buildWaInstallLazyTranslateScript[\s\S]*?return `([\s\S]*?)`;\s*}/);
if (!tplMatch) {
    console.error('NOT_FOUND lazy install script template');
    process.exit(1);
}
const tplBody = tplMatch[1];

const coreMatch = src.match(/const WA_INJECT_TRANSLATE_CORE = `([\s\S]*?)`;\s*$/m);
const rowMatch = src.match(/const WA_INJECT_ROW_COLLECT = `([\s\S]*?)`;\s*$/m);
if (!coreMatch || !rowMatch) {
    console.error('NOT_FOUND core/row template');
    process.exit(1);
}

// Evaluate template literals to obtain the same runtime strings that index.html builds.
const evalTpl = (tplText) => eval('`' + tplText + '`');

const WA_INJECT_TRANSLATE_CORE = evalTpl(coreMatch[1]);
const WA_INJECT_ROW_COLLECT = evalTpl(rowMatch[1]);

const sl = JSON.stringify('auto');
const tl = JSON.stringify('zh-CN');
const en = 'true';

const body = eval('`' + tplBody + '`');

try {
    new vm.Script(body, { filename: 'lazy.js' });
    console.log('SYNTAX_OK len=', body.length);
} catch (err) {
    console.log('SYNTAX_ERR', err && err.message);
    const m = (err && err.stack && err.stack.match(/lazy\.js:(\d+)(?::(\d+))?/)) || null;
    if (m) {
        const lineNo = Number(m[1] || 0);
        const colNo = Number(m[2] || 0);
        const lines = body.split('\n');
        const start = Math.max(1, lineNo - 2);
        const end = Math.min(lines.length, lineNo + 2);
        for (let i = start; i <= end; i++) {
            console.log(String(i).padStart(4, ' '), '|', lines[i - 1]);
            if (i === lineNo && colNo) console.log('     |', ' '.repeat(Math.max(0, colNo - 1)) + '^');
        }
    }
    process.exit(2);
}
