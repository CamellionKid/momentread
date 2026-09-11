import {homedir} from 'node:os';
import {resolve} from 'node:path';
export const dataDir=resolve(process.env.MOMENTREAD_DATA_DIR||resolve(homedir(),'Library/Application Support/MomentRead'));
export const port=Number(process.env.MOMENTREAD_PORT||4317);
export const aiProvider=process.env.MOMENTREAD_AI==='opencode'?'opencode':'claude';
export const aiModel=process.env.MOMENTREAD_AI_MODEL||undefined;
