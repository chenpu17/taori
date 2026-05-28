import { eq, asc } from 'drizzle-orm';
import { type Db } from '../index.js';
import { personas } from '../schema.js';
import type { Persona, PersonaCreate, PersonaUpdate } from '@taori/shared';
import { makeId } from '@taori/shared';
import { pickDefined } from './shared.js';

type PersonaRow = typeof personas.$inferSelect;

function toPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    prompt: row.prompt,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class PersonasRepo {
  constructor(private db: Db) {}

  list(): Persona[] {
    return this.db
      .select()
      .from(personas)
      .orderBy(asc(personas.updated_at), asc(personas.created_at))
      .all()
      .reverse()
      .map(toPersona);
  }

  get(id: string): Persona | null {
    const row = this.db.select().from(personas).where(eq(personas.id, id)).get();
    return row ? toPersona(row) : null;
  }

  create(input: PersonaCreate): Persona {
    const now = Date.now();
    const row = this.db
      .insert(personas)
      .values({
        id: makeId('persona'),
        name: input.name,
        description: input.description ?? null,
        prompt: input.prompt,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toPersona(row);
  }

  update(id: string, patch: PersonaUpdate): Persona | null {
    const row = this.db
      .update(personas)
      .set({
        ...pickDefined(patch, ['name', 'prompt']),
        ...(patch.description !== undefined && {
          description: patch.description ?? null,
        }),
        updated_at: Date.now(),
      })
      .where(eq(personas.id, id))
      .returning()
      .get();
    return row ? toPersona(row) : null;
  }

  delete(id: string): boolean {
    const res = this.db.delete(personas).where(eq(personas.id, id)).run();
    return res.changes > 0;
  }
}
