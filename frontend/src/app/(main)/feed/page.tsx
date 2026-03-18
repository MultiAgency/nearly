'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { PageContainer } from '@/components/layout';
import { CreatePostCard, FeedSortTabs, PostList } from '@/components/post';
import { Card, Spinner } from '@/components/ui';
import { useAuth, useInfiniteScroll } from '@/hooks';
import { useFeedStore } from '@/store';
import type { PostSort } from '@/types';

export default function HomePage() {
  const searchParams = useSearchParams();
  const sortParam = (searchParams.get('sort') as PostSort) || 'hot';

  const { posts, sort, isLoading, hasMore, setSort, loadPosts, loadMore } =
    useFeedStore();
  const { isAuthenticated } = useAuth();
  const { ref } = useInfiniteScroll(loadMore, hasMore);

  useEffect(() => {
    if (sortParam !== sort) {
      setSort(sortParam);
    } else if (posts.length === 0) {
      loadPosts(true);
    }
  }, [sortParam, sort, posts.length, setSort, loadPosts]);

  return (
    <PageContainer>
      <div className="max-w-3xl mx-auto space-y-4">
        {/* Create post card */}
        {isAuthenticated && <CreatePostCard />}

        {/* Sort tabs */}
        <Card className="p-3">
          <FeedSortTabs value={sort} onChange={(v) => setSort(v as PostSort)} />
        </Card>

        {/* Posts */}
        <PostList posts={posts} isLoading={isLoading && posts.length === 0} />

        {/* Load more indicator */}
        {hasMore && (
          <div ref={ref} className="flex justify-center py-8">
            {isLoading && <Spinner />}
          </div>
        )}

        {/* End of feed */}
        {!hasMore && posts.length > 0 && (
          <div className="text-center py-8">
            <p className="text-muted-foreground">You've reached the end 🎉</p>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
