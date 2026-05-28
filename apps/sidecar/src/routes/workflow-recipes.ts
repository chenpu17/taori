import type { FastifyInstance } from 'fastify';
import {
  TaoriError,
  WorkflowRecipeApplyPreviewRequestSchema,
  WorkflowRecipeCreateSchema,
  WorkflowRecipeImportSchema,
  WorkflowRecipeSpecSchema,
  WorkflowRecipeUpdateSchema,
  type WorkflowRecipe,
  type WorkflowRecipeApplyPreview,
} from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import type { MemoriesRepo } from '../db/repos/index.js';
import { readSessionToolEnabled } from './tools.js';

function parseOrValidation<T>(
  result: { success: true; data: T } | { success: false; error: { errors: Array<{ message: string }> } },
): T {
  if (result.success) return result.data;
  throw new TaoriError({
    code: 'validation_error',
    message: result.error.errors.map((e) => e.message).join('; '),
  });
}

function requirePatchFields(patch: Record<string, unknown>): void {
  if (Object.keys(patch).length === 0) {
    throw new TaoriError({ code: 'validation_error', message: 'must provide at least one workflow recipe field' });
  }
}

function renderTemplate(
  template: string,
  values: Record<string, string>,
  variables: WorkflowRecipe['spec']['variables'],
): { prompt: string; missing: string[] } {
  const missing = new Set<string>();
  const byName = new Map(variables.map((variable) => [variable.name, variable]));
  const prompt = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    const variable = byName.get(name);
    const value = values[name] ?? variable?.default_value ?? '';
    if (!value && (variable?.required ?? true)) missing.add(name);
    return value;
  });
  for (const variable of variables) {
    if ((variable.required ?? true) && !values[variable.name] && !variable.default_value) {
      missing.add(variable.name);
    }
  }
  return { prompt, missing: [...missing] };
}

function toolPreview(
  recipe: WorkflowRecipe,
  memories: MemoriesRepo,
  deps: BuildServerArgs,
  conversationId: string | null | undefined,
): WorkflowRecipeApplyPreview['tools'] {
  const tools = deps.bus?.list() ?? [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const mapTool = (name: string) => {
    const tool = byName.get(name);
    const sessionEnabled = conversationId ? readSessionToolEnabled(memories, conversationId, name) : null;
    return {
      name,
      available: Boolean(tool),
      enabled: Boolean(tool?.enabled) && sessionEnabled !== false,
    };
  };
  return {
    required: recipe.spec.tools.required.map(mapTool),
    optional: recipe.spec.tools.optional.map(mapTool),
  };
}

function exportFilename(recipe: WorkflowRecipe): string {
  const slug = recipe.name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `taori-recipe-${slug || recipe.id}.taori-recipe.json`;
}

export function registerWorkflowRecipesRoute(app: FastifyInstance, deps: BuildServerArgs): void {
  const { repos } = deps;
  const recipes = repos.workflowRecipes;
  const memories = repos.memories;

  app.get('/v1/workflow-recipes', async () => ({
    workflow_recipes: recipes.list(),
  }));

  app.post('/v1/workflow-recipes', async (req, reply) => {
    const body = parseOrValidation(WorkflowRecipeCreateSchema.safeParse(req.body));
    reply.code(201);
    return recipes.create(body);
  });

  app.patch<{ Params: { id: string } }>(
    '/v1/workflow-recipes/:id',
    async (req) => {
      const body = parseOrValidation(WorkflowRecipeUpdateSchema.safeParse(req.body));
      requirePatchFields(body);
      const row = recipes.update(req.params.id, body);
      if (!row) {
        throw new TaoriError({ code: 'not_found', message: `Workflow recipe ${req.params.id} not found` });
      }
      return row;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/workflow-recipes/:id',
    async (req, reply) => {
      const ok = recipes.delete(req.params.id);
      if (!ok) {
        throw new TaoriError({ code: 'not_found', message: `Workflow recipe ${req.params.id} not found` });
      }
      reply.code(204).send();
    },
  );

  app.post('/v1/workflow-recipes/import', async (req, reply) => {
    const body = parseOrValidation(WorkflowRecipeImportSchema.safeParse(req.body));
    reply.code(201);
    return recipes.create({
      name: body.spec.name,
      description: body.spec.description ?? null,
      spec: body.spec,
      enabled: body.enabled,
    });
  });

  app.get<{ Params: { id: string } }>(
    '/v1/workflow-recipes/:id/export',
    async (req, reply) => {
      const recipe = recipes.get(req.params.id);
      if (!recipe) {
        throw new TaoriError({ code: 'not_found', message: `Workflow recipe ${req.params.id} not found` });
      }
      const spec = WorkflowRecipeSpecSchema.parse(recipe.spec);
      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${exportFilename(recipe)}"`);
      return JSON.stringify({ spec }, null, 2);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/workflow-recipes/:id/apply-preview',
    async (req) => {
      const recipe = recipes.get(req.params.id);
      if (!recipe) {
        throw new TaoriError({ code: 'not_found', message: `Workflow recipe ${req.params.id} not found` });
      }
      const body = parseOrValidation(WorkflowRecipeApplyPreviewRequestSchema.safeParse(req.body));
      const rendered = renderTemplate(recipe.spec.prompt_template, body.variables, recipe.spec.variables);
      return {
        recipe_id: recipe.id,
        prompt: rendered.prompt,
        missing_variables: rendered.missing,
        persona: recipe.spec.persona,
        tools: toolPreview(recipe, memories, deps, body.conversation_id),
        recommended_task: recipe.spec.recommended_task,
        model_strategy: recipe.spec.model_strategy,
        budget: recipe.spec.budget,
        output_format: recipe.spec.output_format,
      } satisfies WorkflowRecipeApplyPreview;
    },
  );
}
