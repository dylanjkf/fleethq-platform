/**
 * Internal knowledge base: authors write markdown articles (draft →
 * published), plain viewers read only what's published, drafts stay hidden.
 * Category filter + search work; archive removes it from the listing.
 * Permission-gated (knowledge:view/create/archive).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, addUserToCompany, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const AUTHOR = [PERMISSIONS.KNOWLEDGE_VIEW, PERMISSIONS.KNOWLEDGE_CREATE, PERMISSIONS.KNOWLEDGE_ARCHIVE];

describe('Knowledge base (internal articles / SOPs)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it('authors, publishes, reads, filters, edits and archives an article', async () => {
    const tenant = await createTestTenant(AUTHOR);
    const token = await login(tenant.username);

    // Create as a draft.
    const created = await request(app.getHttpServer())
      .post('/v1/knowledge-articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Cold Chain SOP', category: 'Operations', summary: 'How we keep loads cold', body: '# Cold Chain\n\nAlways pre-cool the box.' })
      .expect(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.publishedAt).toBeNull();
    const id = created.body.id as string;

    // Author sees the draft in their list; body isn't shipped in list view.
    const list = await request(app.getHttpServer()).get('/v1/knowledge-articles').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.items.map((a: { id: string }) => a.id)).toContain(id);
    expect(list.body.canAuthor).toBe(true);
    expect(list.body.categories).toContain('Operations');
    expect(list.body.items[0].body).toBeUndefined();

    // Full article fetch returns the body.
    const full = await request(app.getHttpServer()).get(`/v1/knowledge-articles/${id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(full.body.body).toContain('pre-cool');

    // Publish it.
    const published = await request(app.getHttpServer())
      .patch(`/v1/knowledge-articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'published' })
      .expect(200);
    expect(published.body.status).toBe('published');
    expect(published.body.publishedAt).toBeTruthy();

    // Search narrows it.
    const searched = await request(app.getHttpServer())
      .get('/v1/knowledge-articles?search=cold')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(searched.body.items.map((a: { id: string }) => a.id)).toContain(id);

    // Archive removes it from the default listing.
    await request(app.getHttpServer()).post(`/v1/knowledge-articles/${id}/archive`).set('Authorization', `Bearer ${token}`).expect(201);
    const after = await request(app.getHttpServer()).get('/v1/knowledge-articles').set('Authorization', `Bearer ${token}`).expect(200);
    expect(after.body.items.map((a: { id: string }) => a.id)).not.toContain(id);
  });

  it('hides drafts from viewers without authoring rights', async () => {
    const author = await createTestTenant(AUTHOR);
    const authorToken = await login(author.username);
    // Same company, view-only membership.
    const viewer = await addUserToCompany(author.companyId, [PERMISSIONS.KNOWLEDGE_VIEW]);
    const viewerToken = await login(viewer.username);

    const draft = await request(app.getHttpServer())
      .post('/v1/knowledge-articles')
      .set('Authorization', `Bearer ${authorToken}`)
      .send({ title: 'Secret Draft', body: 'not ready' })
      .expect(201);
    const publishedRes = await request(app.getHttpServer())
      .post('/v1/knowledge-articles')
      .set('Authorization', `Bearer ${authorToken}`)
      .send({ title: 'Live Article', body: 'ready', status: 'published' })
      .expect(201);

    const viewerList = await request(app.getHttpServer()).get('/v1/knowledge-articles').set('Authorization', `Bearer ${viewerToken}`).expect(200);
    const ids = viewerList.body.items.map((a: { id: string }) => a.id);
    expect(ids).toContain(publishedRes.body.id);
    expect(ids).not.toContain(draft.body.id);
    expect(viewerList.body.canAuthor).toBe(false);

    // Direct fetch of the draft 404s for the viewer.
    await request(app.getHttpServer()).get(`/v1/knowledge-articles/${draft.body.id}`).set('Authorization', `Bearer ${viewerToken}`).expect(404);
  });

  it('requires knowledge:create to write', async () => {
    const viewer = await createTestTenant([PERMISSIONS.KNOWLEDGE_VIEW]);
    const token = await login(viewer.username);
    const res = await request(app.getHttpServer())
      .post('/v1/knowledge-articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'y' })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.KNOWLEDGE_CREATE);
  });
});
