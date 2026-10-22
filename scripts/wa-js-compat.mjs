/**
 * WA-JS 4.0.0 兼容当前 WhatsApp Web。
 * 官网的 createFanoutMsgStanza 已出现单参数调用；旧交互消息 hook 直接读 args[1].id，
 * 会让原生发送和话术发送一起失败。无法识别的参数交还原生函数，不修改发送内容。
 */
export function patchWaJsForCurrentWhatsApp(source) {
  const replacements = [
    [
      'fanout native-call guard',
      'const i=t[1].id?t[2]:t[1];if(i.buttonsMessage)',
      'const i=t[1]&&t[1].id?t[2]:t[1];if(!i||typeof i!=="object")return e(...t);if(i.buttonsMessage)',
    ],
    [
      'MsgCollection export compatibility',
      '{MsgCollection:"MsgCollectionImpl"},e=>e.MsgCollectionImpl)',
      '{MsgCollection:["MsgCollectionImpl","MsgCollection"]},e=>e.MsgCollectionImpl||e.MsgCollection)',
    ],
    [
      'MsgStore collection export compatibility',
      '(0,u.exportModule)(t,{[e]:["default",r]},e=>(e.default||e[r])instanceof s[r])',
      '"MsgStore"===e?(0,u.exportModule)(t,{[e]:["Msg","default",r]},(e,t)=>("WAWebCollections"===t&&!!e.Msg)||(e.default||e[r])instanceof s[r]):(0,u.exportModule)(t,{[e]:["default",r]},e=>(e.default||e[r])instanceof s[r])',
    ],
  ];
  let result = String(source);
  for (const [label, before, after] of replacements) {
    const matches = result.split(before).length - 1;
    if (matches !== 1) {
      throw new Error(`[wa-js-compat] ${label}: expected one WA-JS 4.0.0 match, found ${matches}; review the installed WA-JS before packaging`);
    }
    result = result.replace(before, after);
  }
  return result;
}
