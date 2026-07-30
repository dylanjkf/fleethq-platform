import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { KnowledgeService } from './knowledge.service';
import { CreateKnowledgeArticleDto } from './dto/create-knowledge-article.dto';
import { UpdateKnowledgeArticleDto } from './dto/update-knowledge-article.dto';
import { ListKnowledgeArticlesDto } from './dto/list-knowledge-articles.dto';

@Controller({ path: 'knowledge-articles', version: '1' })
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Post()
  @RequirePermission(PERMISSIONS.KNOWLEDGE_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateKnowledgeArticleDto) {
    return this.knowledge.create(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.KNOWLEDGE_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListKnowledgeArticlesDto) {
    return this.knowledge.findAll(user.companyId, user.membershipId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.KNOWLEDGE_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.knowledge.findOne(user.companyId, user.membershipId, id);
  }

  /**
   * The imported document behind an article. Gated on `knowledge:view`, not
   * `documents:view`, so publishing an SOP to readers actually makes it readable
   * by them.
   */
  @Get(':id/document')
  @RequirePermission(PERMISSIONS.KNOWLEDGE_VIEW)
  async downloadDocument(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const file = await this.knowledge.downloadSourceDocument(user.companyId, user.membershipId, id);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(file.data);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.KNOWLEDGE_CREATE)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKnowledgeArticleDto,
  ) {
    return this.knowledge.update(user.companyId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.KNOWLEDGE_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.knowledge.archive(user.companyId, id);
  }
}
