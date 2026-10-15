import * as css from 'css-tree';
export interface RemoteFont {family:string;style:string;weight:string;urls:string[];unicodeRange?:string}
export function fontsFromCss(source:string,baseUrl:string):RemoteFont[]{
 const fonts:RemoteFont[]=[];
 try{const ast=css.parse(source);
 css.walk(ast,node=>{
  if(node.type!=='Atrule'||node.name.toLowerCase()!=='font-face'||!node.block)return;
  let family='',style='normal',weight='normal',unicodeRange:string|undefined;const urls:string[]=[];
  node.block.children.forEach(declaration=>{
   if(declaration.type!=='Declaration')return;
   const property=declaration.property.toLowerCase();const value=css.generate(declaration.value);
   if(property==='font-family'){
    const words:string[]=[];css.walk(declaration.value,part=>{if(part.type==='String')words.push(part.value);else if(part.type==='Identifier')words.push(part.name)});family=words.join(' ');
   }else if(property==='font-style'&&/^(normal|italic|oblique)$/.test(value))style=value;
   else if(property==='font-weight'&&/^(normal|bold|[1-9]00(?: [1-9]00)?)$/.test(value))weight=value;
   else if(property==='unicode-range'&&/^(U\+[0-9A-F?]+(?:-[0-9A-F]+)?)(?:,U\+[0-9A-F?]+(?:-[0-9A-F]+)?)*$/i.test(value))unicodeRange=value;
   else if(property==='src')css.walk(declaration.value,part=>{if(part.type==='Url'){try{const url=new URL(part.value,baseUrl);if(['http:','https:'].includes(url.protocol))urls.push(url.href)}catch{}}});
  });
  if(family&&family.length<=200&&urls.length)fonts.push({family,style,weight,urls,unicodeRange});
 });}catch{/* Malformed or inaccessible font rules are omitted. */}
 return fonts.slice(0,100);
}
