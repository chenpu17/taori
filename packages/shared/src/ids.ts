import { customAlphabet } from 'nanoid';

const NANOID_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const NANOID_LEN = 12;

const nano = customAlphabet(NANOID_ALPHABET, NANOID_LEN);

export const ID_PREFIXES = {
  provider: 'prov_',
  model: 'mdl_',
  conversation: 'conv_',
  message: 'msg_',
  file: 'file_',
  file_chunk: 'fchk_',
  roundtable: 'rt_',
  roundtable_message: 'rtmsg_',
  quick_compare: 'qc_',
  quick_compare_output: 'qcout_',
  cost: 'cost_',
  run: 'run_',
  run_event: 'runev_',
  memory: 'mem_',
  mcp_server: 'mcp_',
  prompt_template: 'ptpl_',
  persona: 'per_',
  workflow_recipe: 'wfr_',
} as const;

export type IdPrefixKey = keyof typeof ID_PREFIXES;

export function makeId(kind: IdPrefixKey): string {
  return `${ID_PREFIXES[kind]}${nano()}`;
}

const PREFIX_REGEX = new RegExp(
  `^(?:${Object.values(ID_PREFIXES).join('|')})[${NANOID_ALPHABET}]{${NANOID_LEN}}$`,
);

export function isTaoriId(value: unknown): value is string {
  return typeof value === 'string' && PREFIX_REGEX.test(value);
}
