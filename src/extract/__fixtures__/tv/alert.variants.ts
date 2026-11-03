/** Shaped like a tailwind-variants result: a function carrying its config. */
const tvLike = <T extends object>(config: T) => Object.assign(() => '', config);

export const ALERT_SIZES = ['sm', 'md'] as const;

export const alertVariants = tvLike({
    base: '',
    slots: { base: '', root: 'flex-row items-start', title: 'font-semibold' },
    variants: {
        variant: { soft: {}, notice: { root: 'rounded-notice border-transparent bg-muted' } },
        status: { default: { title: 'text-foreground' }, destructive: { title: ['text-destructive', 'opacity-50'] } },
        size: { sm: { root: 'gap-2', title: 'text-sm' }, md: { root: 'gap-3' } },
        inset: { true: { root: 'px-3' }, false: {} },
    },
    defaultVariants: { variant: 'soft', status: 'default', size: 'md', inset: false },
    compoundVariants: [{ variant: 'soft', status: ['destructive'], class: { root: 'bg-destructive-soft' } }],
});

export const badgeVariants = tvLike({ base: 'rounded-full px-2', slots: {}, variants: { tone: { neutral: 'bg-muted', loud: 'bg-primary' } }, defaultVariants: { tone: 'neutral' }, compoundVariants: [] });
