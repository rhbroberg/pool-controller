declare const qrcode: (typeNumber: number, errorCorrectionLevel: string) => {
    addData(text: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, column: number): boolean;
};
export default qrcode;