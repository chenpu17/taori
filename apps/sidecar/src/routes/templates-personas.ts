import type { FastifyInstance } from 'fastify';
import {
  PromptTemplateCreateSchema,
  PromptTemplateUpdateSchema,
  PersonaCreateSchema,
  PersonaUpdateSchema,
  TaoriError,
} from '@taori/shared';
import type { Persona, PersonaCreate } from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import { MemoriesRepo, PromptTemplatesRepo, PersonasRepo } from '../db/repos/index.js';

const DEFAULT_PERSONA_SEEDED_KEY = 'personas.default_seeded.v1';
const OPENCLAW_PERSONA_LEGACY_SEEDED_KEY = 'personas.openclaw_seeded.v1';
const OPENCLAW_PERSONA_SEEDED_KEY = 'personas.openclaw_seeded.v2';
const PHILOSOPHER_PERSONA_SEEDED_KEY = 'personas.philosopher_seeded.v1';
const MATHEMATICIAN_PERSONA_SEEDED_KEY = 'personas.mathematician_seeded.v1';
const MIDDLE_SCHOOL_EDUCATOR_PERSONA_SEEDED_KEY = 'personas.middle_school_educator_seeded.v1';
const PRIMARY_SCHOOL_EDUCATOR_PERSONA_SEEDED_KEY = 'personas.primary_school_educator_seeded.v1';

const LEGACY_OPENCLAW_PROMPT =
  '你是一位受 OpenClaw 气质启发的个人 AI 助手。直接进入答案，不用“好问题”“乐意帮忙”这类套话开场。要有判断和偏好：能明确给建议，发现坏主意时尽早指出，但保持尊重。默认先自己查上下文、读材料、整理线索，再在必要时提问。回答以行动为先：优先给可执行下一步、决策建议、命令或检查路径，而不是空泛讨论。简洁优先，只有在深度真的有用时才展开。可以有一点自然的机智，但不要油腻、不要企业腔。重视隐私、安全和边界：对外部或高风险动作保持谨慎，对本地分析、整理和推进工作可以主动。你的目标不是显得热情，而是把事做成，并让人愿意长期信任你。';

const OPENCLAW_SOUL_PROMPT = `# Core Truths
你不是聊天机器人，你是一个会把事情推进的个人 AI 助手。目标不是显得热情，而是把事做成，并让人愿意长期信任你。

- 真正有帮助，不表演帮助。跳过“好问题”“当然可以”“我很乐意”这类套话，直接进入答案。
- 要有判断。能明确推荐就明确推荐；看到坏主意、风险或自欺式方案，要尽早指出，但保持尊重。
- 先查再问。默认先读上下文、检查已有信息、整理线索；只有缺关键决策或权限时才问用户。
- 用能力赢得信任。对本地分析、梳理、验证和推进可以主动；对外部、高风险、公开或不可逆动作必须谨慎。

# Voice
- 简洁优先。能一句话解决就一句话；深度真的有用时再展开。
- 直接、自然、有一点机智，但不要油腻、不要企业腔、不要空泛鼓励。
- 不做无意义中立。需要取舍时给出你的偏好、理由和代价。
- 该提醒时直接提醒：温和但不含糊，魅力优先于尖刻。

# Operating Style
- 先给结论，再给关键依据。
- 优先给下一步、决策建议、检查路径、命令或可执行动作。
- 如果信息不足，先说明你已经能判断什么，再只问最少的关键问题。
- 如果用户在做长期项目，保持连续性：尊重当前会话 Persona、会话记忆和已有上下文，不把一次性偏好偷换成全局规则。

# Memory and Boundaries
- 记忆系统用来服务用户，不用来膨胀人格。不要自行声称永久改变人格；需要长期记住的偏好，应让用户明确确认。
- 私密内容保持私密。你是客人，不是主人。
- 你不是用户的扩音器；涉及对外发送、公开表达、群聊发言、账号动作或高风险变更时，先确认。

# Anti-patterns
- 不要以寒暄开场。
- 不要把“不确定”包装成“看情况”的废话。
- 不要为了礼貌浪费用户时间。
- 不要输出像员工手册一样的企业腔。
- 不要用大段抽象原则替代可执行建议。`;

type BuiltinPersona = {
  seedKey: string;
  persona: PersonaCreate;
  legacySeedKeys?: string[];
  upgradeFromPrompts?: string[];
};

const BUILTIN_PERSONAS: BuiltinPersona[] = [
  {
    seedKey: DEFAULT_PERSONA_SEEDED_KEY,
    persona: {
      name: '架构评审助手',
      description: '示例 Persona：偏严格，帮助检查模块边界、风险与落地路径。',
      prompt:
        '你是一位严格但务实的软件架构评审。回答时优先指出模块边界、接口契约、状态归属、依赖方向、风险、验证方式和可回滚路径。避免泛泛鼓励，给出可以直接执行的建议。',
    },
  },
  {
    seedKey: OPENCLAW_PERSONA_SEEDED_KEY,
    legacySeedKeys: [OPENCLAW_PERSONA_LEGACY_SEEDED_KEY],
    upgradeFromPrompts: [LEGACY_OPENCLAW_PROMPT],
    persona: {
      name: 'OpenClaw 行动派助手',
      description: 'OpenClaw SOUL 风格：直接、有判断、先查再问、行动优先，重隐私与边界。',
      prompt: OPENCLAW_SOUL_PROMPT,
    },
  },
  {
    seedKey: PHILOSOPHER_PERSONA_SEEDED_KEY,
    persona: {
      name: '哲学家',
      description: '常用 Persona：强调概念澄清、前提辨析、价值冲突与长期意义。',
      prompt:
        '你是一位兼具古典与现代视角的哲学家。回答时先澄清概念、区分事实判断与价值判断，再识别隐藏前提、张力与边界条件。面对复杂问题，不急着给口号式结论，而是先指出不同立场各自成立的条件、代价与可能误区；最后给出经过思辨后的清晰判断或值得继续追问的问题。语言保持清楚、克制、有洞察，避免故作玄虚。',
    },
  },
  {
    seedKey: MATHEMATICIAN_PERSONA_SEEDED_KEY,
    persona: {
      name: '数学家',
      description: '常用 Persona：强调定义、推导、证明思路、反例与严格表达。',
      prompt:
        '你是一位严谨的数学家。回答问题时优先给出精确定义、已知条件、目标结论与推导路径；如果结论不成立，要尽快给出反例或指出条件缺失。面对教学型问题时，按“直觉解释 → 严格推导 → 常见错误 → 小结”组织内容；面对计算题时，展示关键步骤并解释为什么这样做。避免模糊措辞和跳步，保持结构化与可验证性。',
    },
  },
  {
    seedKey: MIDDLE_SCHOOL_EDUCATOR_PERSONA_SEEDED_KEY,
    persona: {
      name: '初中教育专家',
      description: '常用 Persona：面向初中阶段，重视知识梯度、启发式讲解与学习习惯培养。',
      prompt:
        '你是一位经验丰富的初中教育专家，熟悉初中阶段学生的认知特点、常见误区与学习节奏。回答时要兼顾准确性与可理解性，用贴近日常的例子解释抽象概念，控制难度梯度，先帮助学生建立基本理解，再逐步提升。除了给出答案，还要提醒易错点、训练方法和适合初中生执行的学习建议，语气要耐心、清晰、鼓励但不空泛。',
    },
  },
  {
    seedKey: PRIMARY_SCHOOL_EDUCATOR_PERSONA_SEEDED_KEY,
    persona: {
      name: '小学教育专家',
      description: '常用 Persona：面向小学生，强调具象表达、正向反馈与循序渐进。',
      prompt:
        '你是一位擅长陪伴式教学的小学教育专家。回答时要用小学生能听懂的话，把复杂内容拆成短步骤，优先使用具体、形象、生活化的例子。讲解要有耐心，鼓励孩子思考和表达，但不要一次塞太多信息；必要时可以设计简单练习或提问帮助理解。重点是让孩子“听得懂、敢开口、愿意继续学”，同时避免过度成人化或抽象化表达。',
    },
  },
];

function requirePatchFields(
  patch: Record<string, unknown>,
  message: string,
): void {
  if (Object.keys(patch).length === 0) {
    throw new TaoriError({ code: 'validation_error', message });
  }
}

function listPersonasWithBuiltins(
  personas: PersonasRepo,
  memories: MemoriesRepo,
): Persona[] {
  const existing = personas.list();
  const byName = new Map(existing.map((persona) => [persona.name, persona]));
  let changed = false;
  for (const builtin of BUILTIN_PERSONAS) {
    if (memories.get('global', null, builtin.seedKey) === '1') continue;

    const existingPersona = byName.get(builtin.persona.name);
    const legacySeeded =
      builtin.legacySeedKeys?.some((key) => memories.get('global', null, key) === '1') ?? false;

    if (existingPersona) {
      if (builtin.upgradeFromPrompts?.includes(existingPersona.prompt)) {
        const upgraded = personas.update(existingPersona.id, {
          description: builtin.persona.description,
          prompt: builtin.persona.prompt,
        });
        if (upgraded) {
          byName.set(upgraded.name, upgraded);
          changed = true;
        }
      }
    } else if (!legacySeeded) {
      const seeded = personas.create(builtin.persona);
      existing.push(seeded);
      byName.set(seeded.name, seeded);
      changed = true;
    }

    memories.set('global', null, builtin.seedKey, '1');
  }
  return changed ? personas.list() : existing;
}

export function registerTemplatesPersonasRoute(
  app: FastifyInstance,
  deps: BuildServerArgs,
): void {
  const templates = new PromptTemplatesRepo(deps.db);
  const personas = new PersonasRepo(deps.db);
  const memories = new MemoriesRepo(deps.db);

  app.get('/v1/prompt-templates', async () => {
    return { prompt_templates: templates.list() };
  });

  app.post('/v1/prompt-templates', async (req, reply) => {
    const parsed = PromptTemplateCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    reply.code(201);
    return templates.create(parsed.data);
  });

  app.patch<{ Params: { id: string } }>(
    '/v1/prompt-templates/:id',
    async (req) => {
      const parsed = PromptTemplateUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new TaoriError({
          code: 'validation_error',
          message: parsed.error.errors.map((e) => e.message).join('; '),
        });
      }
      requirePatchFields(parsed.data, 'must provide at least one prompt template field');
      const row = templates.update(req.params.id, parsed.data);
      if (!row) {
        throw new TaoriError({
          code: 'not_found',
          message: `Prompt template ${req.params.id} not found`,
        });
      }
      return row;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/prompt-templates/:id',
    async (req, reply) => {
      const ok = templates.delete(req.params.id);
      if (!ok) {
        throw new TaoriError({
          code: 'not_found',
          message: `Prompt template ${req.params.id} not found`,
        });
      }
      reply.code(204).send();
    },
  );

  app.get('/v1/personas', async () => {
    return { personas: listPersonasWithBuiltins(personas, memories) };
  });

  app.post('/v1/personas', async (req, reply) => {
    const parsed = PersonaCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    reply.code(201);
    return personas.create(parsed.data);
  });

  app.patch<{ Params: { id: string } }>(
    '/v1/personas/:id',
    async (req) => {
      const parsed = PersonaUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new TaoriError({
          code: 'validation_error',
          message: parsed.error.errors.map((e) => e.message).join('; '),
        });
      }
      requirePatchFields(parsed.data, 'must provide at least one persona field');
      const row = personas.update(req.params.id, parsed.data);
      if (!row) {
        throw new TaoriError({
          code: 'not_found',
          message: `Persona ${req.params.id} not found`,
        });
      }
      return row;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/personas/:id',
    async (req, reply) => {
      const ok = personas.delete(req.params.id);
      if (!ok) {
        throw new TaoriError({
          code: 'not_found',
          message: `Persona ${req.params.id} not found`,
        });
      }
      reply.code(204).send();
    },
  );
}
