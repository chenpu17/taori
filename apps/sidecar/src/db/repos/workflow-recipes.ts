import { eq, asc } from 'drizzle-orm';
import { type Db } from '../index.js';
import { workflow_recipes } from '../schema.js';
import type { WorkflowRecipe, WorkflowRecipeCreate, WorkflowRecipeUpdate } from '@taori/shared';
import { WorkflowRecipeSpecSchema, makeId } from '@taori/shared';
import { pickDefined } from './shared.js';

type WorkflowRecipeRow = typeof workflow_recipes.$inferSelect;

function toWorkflowRecipe(row: WorkflowRecipeRow): WorkflowRecipe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.spec_json);
  } catch {
    throw new Error(`Invalid workflow recipe spec stored for ${row.id}`);
  }
  const spec = WorkflowRecipeSpecSchema.parse(parsed);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    schema_version: 1,
    spec,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class WorkflowRecipesRepo {
  constructor(private db: Db) {}

  list(opts: { enabledOnly?: boolean } = {}): WorkflowRecipe[] {
    const rows = this.db
      .select()
      .from(workflow_recipes)
      .where(opts.enabledOnly ? eq(workflow_recipes.enabled, true) : undefined)
      .orderBy(asc(workflow_recipes.updated_at), asc(workflow_recipes.created_at))
      .all()
      .reverse() as WorkflowRecipeRow[];
    return rows.map(toWorkflowRecipe);
  }

  get(id: string): WorkflowRecipe | null {
    const row = this.db
      .select()
      .from(workflow_recipes)
      .where(eq(workflow_recipes.id, id))
      .get() as WorkflowRecipeRow | undefined;
    return row ? toWorkflowRecipe(row) : null;
  }

  create(input: WorkflowRecipeCreate): WorkflowRecipe {
    const now = Date.now();
    const spec = WorkflowRecipeSpecSchema.parse({
      ...input.spec,
      name: input.spec.name || input.name,
      description: input.spec.description ?? input.description ?? null,
    });
    const row = this.db
      .insert(workflow_recipes)
      .values({
        id: makeId('workflow_recipe'),
        name: input.name,
        description: input.description ?? null,
        schema_version: 1,
        spec_json: JSON.stringify(spec),
        enabled: input.enabled ?? true,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get() as WorkflowRecipeRow;
    return toWorkflowRecipe(row);
  }

  update(id: string, patch: WorkflowRecipeUpdate): WorkflowRecipe | null {
    const current = this.get(id);
    if (!current) return null;
    const spec = patch.spec
      ? WorkflowRecipeSpecSchema.parse({
          ...patch.spec,
          name: patch.spec.name || patch.name || current.name,
          description: patch.spec.description ?? patch.description ?? current.description,
        })
      : undefined;
    const row = this.db
      .update(workflow_recipes)
      .set({
        ...pickDefined(patch, ['name', 'enabled']),
        ...(patch.description !== undefined && { description: patch.description ?? null }),
        ...(spec !== undefined && { spec_json: JSON.stringify(spec) }),
        updated_at: Date.now(),
      })
      .where(eq(workflow_recipes.id, id))
      .returning()
      .get() as WorkflowRecipeRow | undefined;
    return row ? toWorkflowRecipe(row) : null;
  }

  delete(id: string): boolean {
    const res = this.db.delete(workflow_recipes).where(eq(workflow_recipes.id, id)).run();
    return res.changes > 0;
  }
}
