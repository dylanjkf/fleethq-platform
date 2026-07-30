import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { membershipHasPermission } from '../common/permissions/membership-has-permission';
import { CreateKnowledgeArticleDto } from './dto/create-knowledge-article.dto';
import { UpdateKnowledgeArticleDto } from './dto/update-knowledge-article.dto';
import { ListKnowledgeArticlesDto } from './dto/list-knowledge-articles.dto';

const AUTHOR_SELECT = { id: true, fullName: true } as const;
/**
 * An imported document is summarised, never inlined — the article list shows
 * "this is a 2 MB PDF called Fatigue_Policy.pdf" and the bytes are fetched only
 * when a reader actually opens it.
 */
const SOURCE_DOCUMENT_SELECT = {
  id: true,
  title: true,
  fileAttachment: { select: { filename: true, contentType: true, byteSize: true } },
} as const;
// The list view never ships the (potentially large) body — that's fetched
// once, on demand, when a reader opens a single article.
const LIST_SELECT = {
  id: true,
  title: true,
  category: true,
  summary: true,
  status: true,
  authorUserId: true,
  authorUser: { select: AUTHOR_SELECT },
  sourceDocumentId: true,
  sourceDocument: { select: SOURCE_DOCUMENT_SELECT },
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
  archivedAt: true,
} as const;

/**
 * The internal knowledge base. An article is authored markdown, an **imported
 * document** (a policy/SOP that already exists as a PDF), or both — a written
 * introduction in front of the official document is the common case.
 *
 * Imported documents are *referenced* from the document library rather than
 * re-uploaded, so a fatigue policy PDF is stored once and can appear as a
 * document, a knowledge article and a form's reference material at the same
 * time. That's the zero-duplicate-data-entry rule applied to files.
 *
 * Drafts are visible only to authors (knowledge:create); plain viewers
 * (knowledge:view) see published articles only. Publishing stamps publishedAt
 * the first time an article goes live.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentsService,
  ) {}

  async create(companyId: string, actorUserId: string, dto: CreateKnowledgeArticleDto) {
    const status = dto.status ?? 'draft';
    const body = dto.body?.trim() || null;
    if (!body && !dto.sourceDocumentId) {
      throw new BadRequestException({
        code: 'KNOWLEDGE_ARTICLE_EMPTY',
        message: 'An article needs either a body or an imported document.',
      });
    }
    return this.prisma.withTenant(companyId, async (tx) => {
      if (dto.sourceDocumentId) await this.requireDocument(tx, companyId, dto.sourceDocumentId);
      return tx.knowledgeArticle.create({
        data: {
          companyId,
          title: dto.title.trim(),
          category: dto.category?.trim() || null,
          summary: dto.summary?.trim() || null,
          body,
          sourceDocumentId: dto.sourceDocumentId ?? null,
          status,
          authorUserId: actorUserId,
          publishedAt: status === 'published' ? new Date() : null,
        },
        select: LIST_SELECT,
      });
    });
  }

  async findAll(companyId: string, membershipId: string, query: ListKnowledgeArticlesDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const canSeeDrafts = await this.hasKnowledgeCreate(tx, membershipId);
      const where: Prisma.KnowledgeArticleWhereInput = query.includeArchived ? {} : { archivedAt: null };
      // Viewers without authoring rights never see drafts, regardless of any
      // status filter they pass.
      if (!canSeeDrafts) {
        where.status = 'published';
      } else if (query.status) {
        where.status = query.status;
      }
      if (query.category) where.category = query.category;
      if (query.search) {
        where.OR = [
          { title: { contains: query.search, mode: 'insensitive' } },
          { summary: { contains: query.search, mode: 'insensitive' } },
          { body: { contains: query.search, mode: 'insensitive' } },
        ];
      }
      const [items, total] = await Promise.all([
        tx.knowledgeArticle.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }],
          select: LIST_SELECT,
          skip: query.skip,
          take: query.take,
        }),
        tx.knowledgeArticle.count({ where }),
      ]);
      const grouped = await tx.knowledgeArticle.groupBy({
        by: ['category'],
        where: { archivedAt: null, category: { not: null } },
      });
      const categories = grouped.map((g) => g.category).filter((c): c is string => !!c).sort();
      return { items, total, categories, canAuthor: canSeeDrafts, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOne(companyId: string, membershipId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const article = await tx.knowledgeArticle.findUnique({
        where: { id },
        select: { ...LIST_SELECT, body: true, companyId: true },
      });
      if (!article || article.companyId !== companyId) {
        throw new NotFoundException({ code: 'KNOWLEDGE_ARTICLE_NOT_FOUND', message: 'Article not found.' });
      }
      // A draft is only readable by an author.
      if (article.status !== 'published' && !(await this.hasKnowledgeCreate(tx, membershipId))) {
        throw new NotFoundException({ code: 'KNOWLEDGE_ARTICLE_NOT_FOUND', message: 'Article not found.' });
      }
      const { companyId: _companyId, ...rest } = article;
      return rest;
    });
  }

  async update(companyId: string, id: string, dto: UpdateKnowledgeArticleDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireArticle(tx, companyId, id);
      const goingLive = dto.status === 'published' && existing.status !== 'published';
      // `null` is how a caller *unlinks* an imported document, which must not be
      // allowed to leave an article with neither a body nor a document.
      if (dto.sourceDocumentId === null && !(dto.body?.trim() || existing.body?.trim())) {
        throw new BadRequestException({
          code: 'KNOWLEDGE_ARTICLE_EMPTY',
          message: 'Removing the document would leave the article empty — add a body first.',
        });
      }
      if (dto.sourceDocumentId) await this.requireDocument(tx, companyId, dto.sourceDocumentId);
      return tx.knowledgeArticle.update({
        where: { id },
        data: {
          title: dto.title?.trim(),
          category: dto.category === undefined ? undefined : dto.category.trim() || null,
          summary: dto.summary === undefined ? undefined : dto.summary.trim() || null,
          body: dto.body,
          sourceDocumentId: dto.sourceDocumentId === undefined ? undefined : dto.sourceDocumentId,
          status: dto.status,
          // Stamp publishedAt the first time it's published; keep the original
          // publish date on any subsequent edit.
          publishedAt: goingLive ? new Date() : undefined,
        },
        select: { ...LIST_SELECT, body: true },
      });
    });
  }

  async archive(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireArticle(tx, companyId, id);
      if (existing.archivedAt) return existing;
      return tx.knowledgeArticle.update({ where: { id }, data: { archivedAt: new Date() }, select: LIST_SELECT });
    });
  }

  /**
   * The bytes of an article's imported document.
   *
   * Served from here rather than sending readers to `/v1/documents/:id/download`
   * on purpose: a driver with `knowledge:view` and no `documents:view` must
   * still be able to read the SOP that was published to them. Access is
   * therefore granted by *the article* — the same draft/published rule as the
   * article body — and never by guessing a document id.
   */
  async downloadSourceDocument(companyId: string, membershipId: string, id: string) {
    const attachmentId = await this.prisma.withTenant(companyId, async (tx) => {
      const article = await tx.knowledgeArticle.findUnique({
        where: { id },
        select: {
          companyId: true,
          status: true,
          sourceDocument: { select: { fileAttachmentId: true } },
        },
      });
      if (!article || article.companyId !== companyId || !article.sourceDocument) {
        throw new NotFoundException({ code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND', message: 'No document on this article.' });
      }
      if (article.status !== 'published' && !(await this.hasKnowledgeCreate(tx, membershipId))) {
        throw new NotFoundException({ code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND', message: 'No document on this article.' });
      }
      return article.sourceDocument.fileAttachmentId;
    });
    return this.attachments.getForDownload(companyId, attachmentId);
  }

  private async requireDocument(tx: Prisma.TransactionClient, companyId: string, documentId: string) {
    // Belt and braces over RLS: a cross-tenant id should read as "not found",
    // not as a foreign-key error leaking that the row exists somewhere.
    const document = await tx.document.findUnique({ where: { id: documentId }, select: { companyId: true } });
    if (!document || document.companyId !== companyId) {
      throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' });
    }
  }

  private hasKnowledgeCreate(tx: Prisma.TransactionClient, membershipId: string): Promise<boolean> {
    return membershipHasPermission(tx, membershipId, PERMISSIONS.KNOWLEDGE_CREATE);
  }

  private async requireArticle(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const article = await tx.knowledgeArticle.findUnique({ where: { id } });
    if (!article || article.companyId !== companyId) {
      throw new NotFoundException({ code: 'KNOWLEDGE_ARTICLE_NOT_FOUND', message: 'Article not found.' });
    }
    return article;
  }
}
