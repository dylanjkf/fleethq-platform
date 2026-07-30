/**
 * Importing documents: a bulk multi-file upload into the document library, the
 * same batch optionally published into the Knowledge Base, and documents
 * referenced from articles and form templates.
 *
 * The assertions that matter are the two things that make a bulk feature usable
 * rather than nominally present: **one bad file must not take the batch down
 * with it**, and **a reader must be able to open a document that was published
 * to them** without also being handed the whole document library.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import {
  TEST_PASSWORD,
  addUserToCompany,
  createTestTenant,
  disconnectFixtures,
  ensureAssetClasses,
  ensurePermissions,
} from './utils/fixtures';

const ownerPrisma = new PrismaClient();

// A minimal real PDF — the attachment path sniffs magic bytes, so "%PDF-" has to
// actually be there.
const PDF_BASE64 = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n').toString('base64');
// Declared as a PDF but isn't one — the mislabelled-file case.
const NOT_A_PDF_BASE64 = Buffer.from('this is plain text pretending to be a pdf').toString('base64');

const LIBRARIAN = [
  PERMISSIONS.DOCUMENTS_VIEW,
  PERMISSIONS.DOCUMENTS_CREATE,
  PERMISSIONS.KNOWLEDGE_VIEW,
  PERMISSIONS.KNOWLEDGE_CREATE,
  PERMISSIONS.FORMS_VIEW,
  PERMISSIONS.FORMS_CREATE,
  PERMISSIONS.FORMS_EDIT,
];

describe('Document import', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  function pdf(filename: string, extra: Record<string, unknown> = {}) {
    return { filename, contentType: 'application/pdf', dataBase64: PDF_BASE64, ...extra };
  }

  it('uploads a batch at once, deriving titles, and one bad file does not fail the rest', async () => {
    const t = await createTestTenant(LIBRARIAN);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    const res = await request(app.getHttpServer())
      .post('/v1/documents/bulk')
      .set(auth)
      .send({
        category: 'Policies',
        files: [
          pdf('Fatigue_Management_Policy_v3.pdf'),
          pdf('Load-Restraint-Guide.pdf', { title: 'Load restraint (official)', category: 'Safety' }),
          // Mislabelled: declared PDF, actually text. Rejected by content sniffing.
          { filename: 'broken.pdf', contentType: 'application/pdf', dataBase64: NOT_A_PDF_BASE64 },
          // Unsupported type — refused at validation, before any bytes are stored.
          { filename: 'sheet.xlsx', contentType: 'application/vnd.ms-excel', dataBase64: PDF_BASE64 },
          pdf('Induction Handbook.pdf'),
        ],
      })
      .expect(201);

    expect(res.body).toMatchObject({ total: 5, createdCount: 3, invalidCount: 2, dryRun: false });
    // Per-file outcomes, indexed so a UI can point at the exact row that failed.
    expect(res.body.rows[0]).toMatchObject({ index: 0, created: true });
    expect(res.body.rows[2]).toMatchObject({ index: 2, created: false });
    expect(res.body.rows[2].errors[0]).toMatch(/does not match its declared type/i);
    expect(res.body.rows[3]).toMatchObject({ index: 3, created: false });
    expect(res.body.rows[4]).toMatchObject({ index: 4, created: true });

    const list = await request(app.getHttpServer()).get('/v1/documents').set(auth).expect(200);
    const titles = list.body.items.map((d: { title: string }) => d.title).sort();
    // Titles came from the filenames; the one explicit title was respected.
    expect(titles).toEqual(['Fatigue Management Policy v3', 'Induction Handbook', 'Load restraint (official)']);
    // The batch category applied to files that didn't set their own.
    const byTitle = (title: string) => list.body.items.find((d: { title: string }) => d.title === title);
    expect(byTitle('Fatigue Management Policy v3').category).toBe('Policies');
    expect(byTitle('Load restraint (official)').category).toBe('Safety');

    // Nothing was written for the two rejected files.
    expect(await ownerPrisma.document.count({ where: { companyId: t.companyId } })).toBe(3);
  });

  it('publishes an imported batch into the Knowledge Base as drafts, referencing the same file', async () => {
    const t = await createTestTenant(LIBRARIAN);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    await request(app.getHttpServer())
      .post('/v1/documents/bulk')
      .set(auth)
      .send({ category: 'SOPs', publishToKnowledgeBase: true, files: [pdf('Yard_Safety_SOP.pdf'), pdf('Refuelling_SOP.pdf')] })
      .expect(201);

    const articles = await request(app.getHttpServer()).get('/v1/knowledge-articles').set(auth).expect(200);
    expect(articles.body.total).toBe(2);
    for (const article of articles.body.items) {
      // Draft, not published: importing a folder is not a decision to publish it.
      expect(article.status).toBe('draft');
      expect(article.category).toBe('SOPs');
      // The article points at the document — the bytes were not stored twice.
      expect(article.sourceDocument).toMatchObject({
        fileAttachment: { contentType: 'application/pdf' },
      });
    }

    // One Attachment per file, not two, is the whole point of referencing.
    expect(await ownerPrisma.attachment.count({ where: { companyId: t.companyId } })).toBe(2);
  });

  it('refuses to publish into the knowledge base without knowledge:create', async () => {
    // Can upload documents, cannot author articles.
    const t = await createTestTenant([PERMISSIONS.DOCUMENTS_VIEW, PERMISSIONS.DOCUMENTS_CREATE]);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    const denied = await request(app.getHttpServer())
      .post('/v1/documents/bulk')
      .set(auth)
      .send({ publishToKnowledgeBase: true, files: [pdf('Policy.pdf')] })
      .expect(403);
    expect(denied.body.error).toMatchObject({ requiredPermission: PERMISSIONS.KNOWLEDGE_CREATE });

    // Refused before anything was uploaded — not a half-done import.
    expect(await ownerPrisma.document.count({ where: { companyId: t.companyId } })).toBe(0);

    // The same batch without the knowledge-base flag is fine.
    await request(app.getHttpServer()).post('/v1/documents/bulk').set(auth).send({ files: [pdf('Policy.pdf')] }).expect(201);
  });

  it('lets a reader open a published article’s document without documents:view', async () => {
    const t = await createTestTenant(LIBRARIAN);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };
    // A driver: can read the knowledge base, has no access to the document library.
    const reader = await addUserToCompany(t.companyId, [PERMISSIONS.KNOWLEDGE_VIEW]);
    const readerAuth = { Authorization: `Bearer ${await login(reader.username)}` };

    const doc = await request(app.getHttpServer())
      .post('/v1/documents')
      .set(auth)
      .send({ title: 'Fatigue policy', filename: 'fatigue.pdf', contentType: 'application/pdf', dataBase64: PDF_BASE64 })
      .expect(201);

    const article = await request(app.getHttpServer())
      .post('/v1/knowledge-articles')
      .set(auth)
      .send({ title: 'Fatigue policy', sourceDocumentId: doc.body.id, summary: 'Read before driving.' })
      .expect(201);

    // While it's a draft, a plain reader can't see it at all — same rule as a body.
    await request(app.getHttpServer()).get(`/v1/knowledge-articles/${article.body.id}/document`).set(readerAuth).expect(404);
    // ...and the document library itself stays closed to them.
    await request(app.getHttpServer()).get(`/v1/documents/${doc.body.id}/download`).set(readerAuth).expect(403);

    await request(app.getHttpServer())
      .patch(`/v1/knowledge-articles/${article.body.id}`)
      .set(auth)
      .send({ status: 'published' })
      .expect(200);

    const download = await request(app.getHttpServer())
      .get(`/v1/knowledge-articles/${article.body.id}/document`)
      .set(readerAuth)
      .expect(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.body.toString('utf8').startsWith('%PDF-')).toBe(true);
  });

  it('needs a body or a document, and will not let the last one be removed', async () => {
    const t = await createTestTenant(LIBRARIAN);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    const empty = await request(app.getHttpServer())
      .post('/v1/knowledge-articles')
      .set(auth)
      .send({ title: 'Nothing in here' })
      .expect(400);
    expect(empty.body.error.code).toBe('KNOWLEDGE_ARTICLE_EMPTY');

    const doc = await request(app.getHttpServer())
      .post('/v1/documents')
      .set(auth)
      .send({ title: 'SOP', filename: 'sop.pdf', contentType: 'application/pdf', dataBase64: PDF_BASE64 })
      .expect(201);
    const article = await request(app.getHttpServer())
      .post('/v1/knowledge-articles')
      .set(auth)
      .send({ title: 'SOP', sourceDocumentId: doc.body.id })
      .expect(201);

    // Unlinking the document from a body-less article would leave nothing at all.
    const stripped = await request(app.getHttpServer())
      .patch(`/v1/knowledge-articles/${article.body.id}`)
      .set(auth)
      .send({ sourceDocumentId: null })
      .expect(400);
    expect(stripped.body.error.code).toBe('KNOWLEDGE_ARTICLE_EMPTY');

    // Supplying a body in the same edit makes it legal.
    const rewritten = await request(app.getHttpServer())
      .patch(`/v1/knowledge-articles/${article.body.id}`)
      .set(auth)
      .send({ sourceDocumentId: null, body: 'Superseded — see the new process below.' })
      .expect(200);
    expect(rewritten.body.sourceDocumentId).toBeNull();
  });

  it('attaches a reference document to a form template, readable with only forms:view', async () => {
    const t = await createTestTenant(LIBRARIAN);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };
    const filler = await addUserToCompany(t.companyId, [PERMISSIONS.FORMS_VIEW]);
    const fillerAuth = { Authorization: `Bearer ${await login(filler.username)}` };

    const doc = await request(app.getHttpServer())
      .post('/v1/documents')
      .set(auth)
      .send({ title: 'Hazard sheet', filename: 'hazard.pdf', contentType: 'application/pdf', dataBase64: PDF_BASE64 })
      .expect(201);

    const template = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set(auth)
      .send({
        name: 'Yard hazard report',
        referenceDocumentId: doc.body.id,
        fields: [{ id: 'seen', label: 'What did you see?', type: 'text', required: true }],
      })
      .expect(201);
    expect(template.body.referenceDocument).toMatchObject({ title: 'Hazard sheet' });

    const reference = await request(app.getHttpServer())
      .get(`/v1/form-templates/${template.body.id}/reference`)
      .set(fillerAuth)
      .expect(200);
    expect(reference.headers['content-type']).toContain('application/pdf');

    // Detaching leaves the form (and its version) intact — the questions asked
    // did not change, so past submissions are unaffected.
    const detached = await request(app.getHttpServer())
      .patch(`/v1/form-templates/${template.body.id}`)
      .set(auth)
      .send({ referenceDocumentId: null })
      .expect(200);
    expect(detached.body.referenceDocument).toBeNull();
    expect(detached.body.version).toBe(template.body.version);
    await request(app.getHttpServer()).get(`/v1/form-templates/${template.body.id}/reference`).set(fillerAuth).expect(404);
  });

  it('will not link another company’s document', async () => {
    const a = await createTestTenant(LIBRARIAN);
    const b = await createTestTenant(LIBRARIAN);
    const authA = { Authorization: `Bearer ${await login(a.username)}` };
    const authB = { Authorization: `Bearer ${await login(b.username)}` };

    const doc = await request(app.getHttpServer())
      .post('/v1/documents')
      .set(authA)
      .send({ title: 'Private', filename: 'private.pdf', contentType: 'application/pdf', dataBase64: PDF_BASE64 })
      .expect(201);

    // Company B knows the id but must be told only that it doesn't exist.
    await request(app.getHttpServer())
      .post('/v1/knowledge-articles')
      .set(authB)
      .send({ title: 'Borrowed', sourceDocumentId: doc.body.id })
      .expect(404);
    await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set(authB)
      .send({
        name: 'Borrowed form',
        referenceDocumentId: doc.body.id,
        fields: [{ id: 'anything', label: 'Anything', type: 'text', required: false }],
      })
      .expect(404);
  });
});
