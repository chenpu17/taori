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
  roundtable: 'rt_',
  cost: 'cost_',
  memory: 'mem_',
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
