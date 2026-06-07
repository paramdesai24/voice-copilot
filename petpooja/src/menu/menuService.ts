/**
 * Menu Service
 * CRUD for menu items and categories backed directly by PostgreSQL.
 */

import { MenuItem, MenuCategory, DBMenuItem } from '../types';
import { query, queryOne, queryMany } from '../database/postgres';
import { createServiceLogger } from '../utils/logger';
import { NotFoundError } from '../utils/errors';
import { toNumber } from '../utils/helpers';

const log = createServiceLogger('MenuService');

// ── In-process menu cache ─────────────────────────────────────────────────────
// The menu rarely changes during a session. A 60-second TTL eliminates
// repeated DB round-trips (each ~100-400ms on Neon) during a single call.
const _menuCache = new Map<string, { items: MenuItem[]; expiresAt: number }>();
const _nameCache = new Map<string, { name: string; expiresAt: number }>();
const MENU_TTL_MS = 60_000;   // 60 seconds

export class MenuService {
    /**
     * Get all available menu items for a restaurant.
     * Results are cached in-process for MENU_TTL_MS milliseconds.
     */
    async getAvailableItems(restaurantId: string): Promise<MenuItem[]> {
        const cached = _menuCache.get(restaurantId);
        if (cached && Date.now() < cached.expiresAt) {
            log.debug('Menu loaded from cache', { restaurantId, count: cached.items.length });
            return cached.items;
        }

        const rows = await queryMany<DBMenuItem>(
            `SELECT * FROM menu_items
       WHERE restaurant_id = $1 AND is_available = TRUE
       ORDER BY category, name`,
            [restaurantId]
        );
        const items = rows.map(this.hydrateMenuItem);
        log.debug('Menu loaded from DB', { restaurantId, count: items.length });

        _menuCache.set(restaurantId, { items, expiresAt: Date.now() + MENU_TTL_MS });
        return items;
    }

    /**
     * Get a single menu item by ID.
     */
    async getMenuItem(itemId: string): Promise<MenuItem> {
        const row = await queryOne<DBMenuItem>(
            'SELECT * FROM menu_items WHERE id = $1',
            [itemId]
        );
        if (!row) throw new NotFoundError('MenuItem', itemId);
        return this.hydrateMenuItem(row);
    }

    /**
     * Get the restaurant's display name.
     * Cached for MENU_TTL_MS milliseconds.
     */
    async getRestaurantName(restaurantId: string): Promise<string> {
        const cached = _nameCache.get(restaurantId);
        if (cached && Date.now() < cached.expiresAt) {
            return cached.name;
        }
        const row = await queryOne<{ name: string }>(
            'SELECT name FROM restaurants WHERE id = $1',
            [restaurantId]
        );
        const name = row?.name ?? 'Restaurant';
        _nameCache.set(restaurantId, { name, expiresAt: Date.now() + MENU_TTL_MS });
        return name;
    }

    /**
     * Get all categories for a restaurant.
     */
    async getCategories(restaurantId: string): Promise<MenuCategory[]> {
        return queryMany<MenuCategory>(
            `SELECT * FROM menu_categories
       WHERE restaurant_id = $1 AND is_available = TRUE
       ORDER BY sort_order`,
            [restaurantId]
        );
    }

    /**
     * Create a new menu item.
     */
    async createMenuItem(params: {
        restaurant_id: string;
        category_id: string;
        category: string;
        name: string;
        name_hi?: string;
        name_hinglish?: string;
        aliases?: string[];
        description?: string;
        price: number;
        is_available?: boolean;
        is_vegetarian?: boolean;
        modifier_groups?: unknown[];
        tags?: string[];
        pos_item_id: string;
    }): Promise<MenuItem> {
        const result = await query<DBMenuItem>(
            `INSERT INTO menu_items
        (restaurant_id, category_id, category, name, name_hi, name_hinglish,
         aliases, description, price, is_available, is_vegetarian,
         modifier_groups, tags, pos_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
            [
                params.restaurant_id,
                params.category_id,
                params.category,
                params.name,
                params.name_hi ?? null,
                params.name_hinglish ?? null,
                params.aliases ?? [],
                params.description ?? null,
                params.price,
                params.is_available ?? true,
                params.is_vegetarian ?? false,
                JSON.stringify(params.modifier_groups ?? []),
                params.tags ?? [],
                params.pos_item_id,
            ]
        );

        await this.invalidateCache(params.restaurant_id);
        return this.hydrateMenuItem(result.rows[0]);
    }

    /**
     * Update a menu item.
     */
    async updateMenuItem(
        itemId: string,
        updates: Partial<{
            name: string;
            price: number;
            is_available: boolean;
            description: string;
        }>
    ): Promise<MenuItem> {
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        for (const [key, value] of Object.entries(updates)) {
            fields.push(`${key} = $${idx++}`);
            values.push(value);
        }
        fields.push(`updated_at = NOW()`);
        values.push(itemId);

        const result = await query<DBMenuItem>(
            `UPDATE menu_items SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );

        if (!result.rows.length) throw new NotFoundError('MenuItem', itemId);

        const item = this.hydrateMenuItem(result.rows[0]);
        this.invalidateCache(item.restaurant_id);
        return item;
    }

    /**
     * Toggle item availability.
     */
    async setAvailability(itemId: string, available: boolean): Promise<void> {
        const result = await query<{ restaurant_id: string }>(
            `UPDATE menu_items SET is_available = $1, updated_at = NOW()
       WHERE id = $2 RETURNING restaurant_id`,
            [available, itemId]
        );
        if (!result.rows.length) throw new NotFoundError('MenuItem', itemId);
        this.invalidateCache(result.rows[0].restaurant_id);
    }

    // ── Private ─────────────────────────────────────────────────────────────────
    private hydrateMenuItem(row: DBMenuItem): MenuItem {
        return {
            ...row,
            name_hi: row.name_hi ?? undefined,
            name_hinglish: (row as unknown as { name_hinglish?: string | null }).name_hinglish ?? undefined,
            description: (row as unknown as { description?: string | null }).description ?? undefined,
            image_url: (row as unknown as { image_url?: string | null }).image_url ?? undefined,
            price: toNumber(row.price),
            modifier_groups:
                typeof row.modifier_groups === 'string'
                    ? JSON.parse(row.modifier_groups)
                    : row.modifier_groups ?? [],
            aliases: row.aliases ?? [],
            tags: row.tags ?? [],
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at),
        };
    }

    private invalidateCache(restaurantId: string): void {
        log.debug('Cache invalidated (no-op in hackathon mode)', { restaurantId });
    }
}
