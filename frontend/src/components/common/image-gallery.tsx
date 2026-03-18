'use client';

import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  Minimize2,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import Image from 'next/image';
import * as React from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';

interface ImageItem {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
  caption?: string;
}

interface ImageGalleryProps {
  images: ImageItem[];
  className?: string;
  columns?: 1 | 2 | 3 | 4;
  gap?: 'sm' | 'md' | 'lg';
  aspectRatio?: 'square' | 'video' | 'auto';
}

export function ImageGallery({
  images,
  className,
  columns = 3,
  gap = 'md',
  aspectRatio = 'auto',
}: ImageGalleryProps) {
  const [selectedIndex, setSelectedIndex] = React.useState<number | null>(null);

  const gapClasses = { sm: 'gap-2', md: 'gap-4', lg: 'gap-6' };
  const colClasses = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
  };
  const aspectClasses = {
    square: 'aspect-square',
    video: 'aspect-video',
    auto: '',
  };

  return (
    <>
      <div
        className={cn('grid', colClasses[columns], gapClasses[gap], className)}
      >
        {images.map((image, index) => (
          <button
            key={index}
            onClick={() => setSelectedIndex(index)}
            className={cn(
              'relative overflow-hidden rounded-lg bg-muted cursor-zoom-in group',
              aspectClasses[aspectRatio],
            )}
          >
            <Image
              src={image.src}
              alt={image.alt || `Image ${index + 1}`}
              fill={aspectRatio !== 'auto'}
              width={aspectRatio === 'auto' ? image.width || 400 : undefined}
              height={aspectRatio === 'auto' ? image.height || 300 : undefined}
              className={cn(
                'object-cover transition-transform duration-300 group-hover:scale-105',
                aspectRatio === 'auto' && 'w-full h-auto',
              )}
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
              <ZoomIn className="h-8 w-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            {image.caption && (
              <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent">
                <p className="text-white text-sm truncate">{image.caption}</p>
              </div>
            )}
          </button>
        ))}
      </div>

      {selectedIndex !== null && (
        <ImageLightbox
          images={images}
          initialIndex={selectedIndex}
          onClose={() => setSelectedIndex(null)}
        />
      )}
    </>
  );
}

interface ImageLightboxProps {
  images: ImageItem[];
  initialIndex: number;
  onClose: () => void;
}

export function ImageLightbox({
  images,
  initialIndex,
  onClose,
}: ImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = React.useState(initialIndex);
  const [zoom, setZoom] = React.useState(1);
  const [rotation, setRotation] = React.useState(0);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const currentImage = images[currentIndex];
  const hasMultiple = images.length > 1;

  const goNext = () => setCurrentIndex((i) => (i + 1) % images.length);
  const goPrev = () =>
    setCurrentIndex((i) => (i - 1 + images.length) % images.length);
  const zoomIn = () => setZoom((z) => Math.min(z + 0.5, 4));
  const zoomOut = () => setZoom((z) => Math.max(z - 0.5, 0.5));
  const rotate = () => setRotation((r) => (r + 90) % 360);
  const resetView = () => {
    setZoom(1);
    setRotation(0);
  };

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const downloadImage = async () => {
    const response = await fetch(currentImage.src);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `image-${currentIndex + 1}.jpg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Keyboard navigation
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          goPrev();
          break;
        case 'ArrowRight':
          goNext();
          break;
        case 'Escape':
          onClose();
          break;
        case '+':
        case '=':
          zoomIn();
          break;
        case '-':
          zoomOut();
          break;
        case 'r':
          rotate();
          break;
        case '0':
          resetView();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // biome-ignore lint/correctness/useExhaustiveDependencies: callbacks are stable in practice
  }, [goNext, goPrev, onClose, resetView, rotate, zoomIn, zoomOut]);

  // Reset view when image changes
  React.useEffect(() => {
    resetView();
    // biome-ignore lint/correctness/useExhaustiveDependencies: resetView is stable
  }, [resetView]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 bg-black/95 flex flex-col"
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between p-4 bg-black/50">
        <div className="flex items-center gap-2">
          <span className="text-white text-sm">
            {currentIndex + 1} / {images.length}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={zoomOut}
            className="text-white hover:bg-white/20"
          >
            <ZoomOut className="h-5 w-5" />
          </Button>
          <span className="text-white text-sm w-16 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={zoomIn}
            className="text-white hover:bg-white/20"
          >
            <ZoomIn className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={rotate}
            className="text-white hover:bg-white/20"
          >
            <RotateCw className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleFullscreen}
            className="text-white hover:bg-white/20"
          >
            {isFullscreen ? (
              <Minimize2 className="h-5 w-5" />
            ) : (
              <Maximize2 className="h-5 w-5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={downloadImage}
            className="text-white hover:bg-white/20"
          >
            <Download className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="text-white hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Image container */}
      <div className="flex-1 flex items-center justify-center overflow-hidden relative">
        {/* Previous button */}
        {hasMultiple && (
          <Button
            variant="ghost"
            size="icon"
            onClick={goPrev}
            className="absolute left-4 z-10 text-white hover:bg-white/20 h-12 w-12"
          >
            <ChevronLeft className="h-8 w-8" />
          </Button>
        )}

        {/* Image */}
        <div
          className="relative transition-transform duration-200"
          style={{
            transform: `scale(${zoom}) rotate(${rotation}deg)`,
          }}
        >
          <Image
            src={currentImage.src}
            alt={currentImage.alt || ''}
            width={currentImage.width || 1200}
            height={currentImage.height || 800}
            className="max-h-[80vh] max-w-[90vw] object-contain"
            priority
          />
        </div>

        {/* Next button */}
        {hasMultiple && (
          <Button
            variant="ghost"
            size="icon"
            onClick={goNext}
            className="absolute right-4 z-10 text-white hover:bg-white/20 h-12 w-12"
          >
            <ChevronRight className="h-8 w-8" />
          </Button>
        )}
      </div>

      {/* Caption */}
      {currentImage.caption && (
        <div className="p-4 bg-black/50 text-center">
          <p className="text-white">{currentImage.caption}</p>
        </div>
      )}

      {/* Thumbnails */}
      {hasMultiple && images.length <= 10 && (
        <div className="flex justify-center gap-2 p-4 bg-black/50">
          {images.map((image, index) => (
            <button
              key={index}
              onClick={() => setCurrentIndex(index)}
              className={cn(
                'w-16 h-16 rounded overflow-hidden border-2 transition-colors',
                currentIndex === index
                  ? 'border-white'
                  : 'border-transparent opacity-60 hover:opacity-100',
              )}
            >
              <Image
                src={image.src}
                alt=""
                width={64}
                height={64}
                className="w-full h-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Single image with lightbox
export function ImageWithLightbox({
  src,
  alt,
  width,
  height,
  className,
  caption,
}: ImageItem & { className?: string }) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          'relative overflow-hidden rounded-lg cursor-zoom-in group',
          className,
        )}
      >
        <Image
          src={src}
          alt={alt || ''}
          width={width || 800}
          height={height || 600}
          className="transition-transform duration-300 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
      </button>

      {open && (
        <ImageLightbox
          images={[{ src, alt, width, height, caption }]}
          initialIndex={0}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
