import type { FastifyInstance } from 'fastify';
import {
  PromptTemplateCreateSchema,
  PromptTemplateUpdateSchema,
  PersonaCreateSchema,
  PersonaUpdateSchema,
  TaoriError,
} from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import { PromptTemplatesRepo, PersonasRepo } from '../db/repos/index.js';

function requirePatchFields(
  patch: Record<string, unknown>,
  message: string,
): void {
  if (Object.keys(patch).length === 0) {
    throw new TaoriError({ code: 'validation_error', message });
  }
}

export function registerTemplatesPersonasRoute(
  app: FastifyInstance,
  deps: BuildServerArgs,
): void {
  const templates = new PromptTemplatesRepo(deps.db);
  const personas = new PersonasRepo(deps.db);

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
    return { personas: personas.list() };
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
