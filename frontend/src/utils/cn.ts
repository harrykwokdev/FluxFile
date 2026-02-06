/**
 * 类名合并工具函数
 * ==================
 * 
 * 使用 tailwind-merge 和 clsx 合并 CSS 类名。
 * 处理条件类名、重复类名合并等。
 */

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并 CSS 类名
 * 
 * 支持：
 * - 字符串类名
 * - 条件对象 { 'class-name': condition }
 * - 数组
 * - undefined/null（自动过滤）
 * 
 * 使用 tailwind-merge 智能合并 Tailwind 类（如 px-2 和 px-4 只保留后者）
 * 
 * @example
 * cn('px-2', 'py-4') // => 'px-2 py-4'
 * cn('px-2', { 'bg-red-500': isError })
 * cn('px-2', undefined, 'py-4') // => 'px-2 py-4'
 * cn('px-2', 'px-4') // => 'px-4' (tailwind-merge)
 */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
