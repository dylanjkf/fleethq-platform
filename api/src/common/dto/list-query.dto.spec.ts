import { ListQueryDto } from './list-query.dto';

describe('ListQueryDto', () => {
  it('defaults to page 1 of 25', () => {
    const dto = new ListQueryDto();
    expect(dto.skip).toBe(0);
    expect(dto.take).toBe(25);
  });

  it('computes skip from page and pageSize', () => {
    const dto = new ListQueryDto();
    dto.page = 3;
    dto.pageSize = 10;
    expect(dto.skip).toBe(20);
    expect(dto.take).toBe(10);
  });
});
