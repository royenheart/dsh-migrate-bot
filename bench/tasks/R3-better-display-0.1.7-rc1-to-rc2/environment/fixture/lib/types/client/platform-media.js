/** RC2 Chat's same-origin local media contract. Authorization stays Host-side. */
export function localPathMediaUrl(protocol, origin, value) {
    if (protocol !== 'http:' && protocol !== 'https:')
        return undefined;
    if (!value.startsWith('/') || value.startsWith('//'))
        return undefined;
    return `${origin}/api/file?path=${encodeURIComponent(value)}`;
}
export const readerPathImages = {
    resolve: (value) => typeof window === 'undefined' ? undefined
        : localPathMediaUrl(window.location.protocol, window.location.origin, value),
};
//# sourceMappingURL=platform-media.js.map