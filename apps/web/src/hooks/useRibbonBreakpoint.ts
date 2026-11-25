import { Grid } from 'antd';

export function useRibbonBreakpoint() {
  const screens = Grid.useBreakpoint();
  return {
    isMobile: screens.md === false,
    isTablet: screens.md === true && screens.lg === false,
  };
}
