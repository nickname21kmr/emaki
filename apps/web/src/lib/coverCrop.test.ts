import { expect, it } from 'vitest';
import { coverPosition, pickFocus } from './coverCrop';

it('跟着构图时有 legsY 才换高度；保头模式和手动焦点不变', () => {
  const auto = { x: 0.5, y: 0.35, space: 'image' as const, legsY: 0.7 };
  expect(pickFocus(auto, 'composition').y).toBe(0.7);
  expect(pickFocus(auto, 'head').y).toBe(0.35);
  expect(pickFocus({ x: 0.5, y: 0.35, space: 'image' }, 'composition').y).toBe(0.35);
  expect(pickFocus({ x: 0.5, y: 0.2, legsY: 0.7 }, 'composition').y).toBe(0.2);
});

it('keeps the same subject visible in wide, portrait and avatar frames', () => {
  const image={width:2000,height:3200},focus={x:0.5,y:0.3,space:'image' as const};
  for (const frame of [{width:500,height:204},{width:236,height:315},{width:48,height:48},{width:800,height:160}]) {
    const p=coverPosition(focus,image,frame);
    const scale=Math.max(frame.width/image.width,frame.height/image.height);
    const top=p.y*(image.height*scale-frame.height);
    const subject=focus.y*image.height*scale-top;
    expect(subject).toBeGreaterThanOrEqual(0);
    expect(subject).toBeLessThanOrEqual(frame.height);
    if(p.y>0&&p.y<1)expect(subject).toBeCloseTo(frame.height/2);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top+frame.height).toBeLessThanOrEqual(image.height*scale+1e-8);
  }
});

it('changes the overflow offset on resize instead of reusing an image coordinate as CSS', () => {
  const f={x:0.5,y:0.3,space:'image' as const},image={width:2000,height:3200};
  expect(coverPosition(f,image,{width:500,height:204}).y).toBeCloseTo((240-102)/(800-204));
  expect(coverPosition(f,image,{width:236,height:315}).y).toBe(0);
});

it('uses the horizontal axis for landscape artwork in a portrait card', () => {
  const p=coverPosition({x:0.7,y:0.2,space:'image'},{width:2400,height:1200},{width:300,height:400});
  expect(p.x).toBeCloseTo((560-150)/500);expect(p.y).toBe(0.5);
});

it('preserves manual and legacy CSS positions exactly', () => {
  for (const frame of [{width:500,height:204},{width:48,height:48}])
    expect(coverPosition({x:0.13,y:0.84},{width:2000,height:3200},frame)).toEqual({x:0.13,y:0.84});
});

it('handles unloaded images, hidden frames and no-overflow geometry without NaN', () => {
  const focus={x:0.5,y:0.28,space:'image' as const};
  expect(coverPosition(focus,{width:0,height:0},{width:400,height:200})).toEqual({x:0.5,y:0.5});
  expect(coverPosition(focus,{width:100,height:100},{width:0,height:0})).toEqual({x:0.5,y:0.5});
  expect(coverPosition(focus,{width:100,height:100},{width:200,height:200})).toEqual({x:0.5,y:0.5});
  expect(coverPosition({x:NaN,y:Infinity,space:'image'},{width:100,height:200},{width:100,height:100})).toEqual({x:0.5,y:0.5});
});
