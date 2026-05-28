import { eq, asc } from 'drizzle-orm';
import { type Db } from '../index.js';
import { prompt_templates } from '../schema.js';
import type { PromptTemplate, PromptTemplateCreate, PromptTemplateUpdate } from '@taori/shared';
import { makeId } from '@taori/shared';
import { pickDefined } from './shared.js';

type PromptTemplateRow = typeof prompt_templates.$inferSelect;

function toPromptTemplate(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    content: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class PromptTemplatesRepo {
  constructor(private db: Db) {}

  list(): PromptTemplate[] {
    return this.db
      .select()
      .from(prompt_templates)
      .orderBy(asc(prompt_templates.updated_at), asc(prompt_templates.created_at))
      .all()
      .reverse()
      .map(toPromptTemplate);
  }

  get(id: string): PromptTemplate | null {
    const row = this.db
      .select()
      .from(prompt_templates)
      .where(eq(prompt_templates.id, id))
      .get();
    return row ? toPromptTemplate(row) : null;
  }

  create(input: PromptTemplateCreate): PromptTemplate {
    const now = Date.now();
    const row = this.db
      .insert(prompt_templates)
      .values({
        id: makeId('prompt_template'),
        name: input.name,
        description: input.description ?? null,
        content: input.content,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toPromptTemplate(row);
  }

  update(id: string, patch: PromptTemplateUpdate): PromptTemplate | null {
    const row = this.db
      .update(prompt_templates)
      .set({
        ...pickDefined(patch, ['name', 'content']),
        ...(patch.description !== undefined && {
          description: patch.description ?? null,
        }),
        updated_at: Date.now(),
      })
      .where(eq(prompt_templates.id, id))
      .returning()
      .get();
    return row ? toPromptTemplate(row) : null;
  }

  delete(id: string): boolean {
    const res = this.db
      .delete(prompt_templates)
      .where(eq(prompt_templates.id, id))
      .run();
    return res.changes > 0;
  }
}
