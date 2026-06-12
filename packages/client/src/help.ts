const SLIDES = [
  {
    emoji: '🐾',
    title: 'Hop around',
    text: 'On your turn, hop one space up, down, left or right. Glowing dots show every spot you can reach — tap one to go!',
  },
  {
    emoji: '🤸',
    title: 'Leap over friends',
    text: 'Face to face with another critter? Jump straight over them! If a fence or the garden edge blocks the leap, you may hop diagonally beside them instead.',
  },
  {
    emoji: '🪵',
    title: 'Build fences',
    text: "Or spend your turn placing a fence to slow rivals down. Fences can't cross each other — and you may never fence anyone in completely. Everyone must keep a path home!",
  },
  {
    emoji: '🏁',
    title: 'Race home',
    text: 'The first critter to reach the far side of the garden wins! Spend your fences wisely — you only have so many.',
  },
];

const SEEN_KEY = 'quori-help-seen';
let idx = 0;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function render(): void {
  const slide = SLIDES[idx];
  $('help-slide').innerHTML = `
    <div class="help-emoji">${slide.emoji}</div>
    <h2>${slide.title}</h2>
    <p>${slide.text}</p>`;
  $('help-dots').innerHTML = SLIDES.map((_, i) => `<span class="${i === idx ? 'on' : ''}"></span>`).join('');
  ($('help-prev') as HTMLButtonElement).style.visibility = idx === 0 ? 'hidden' : 'visible';
  $('help-next').textContent = idx === SLIDES.length - 1 ? "Let's play! 🌷" : 'Next →';
}

function close(): void {
  localStorage.setItem(SEEN_KEY, '1');
  $('help-overlay').classList.add('hidden');
}

export function helpSeen(): boolean {
  return localStorage.getItem(SEEN_KEY) === '1';
}

export function showHelp(): void {
  idx = 0;
  render();
  $('help-overlay').classList.remove('hidden');
}

export function initHelp(): void {
  $('help-prev').addEventListener('click', () => {
    if (idx > 0) {
      idx--;
      render();
    }
  });
  $('help-next').addEventListener('click', () => {
    if (idx < SLIDES.length - 1) {
      idx++;
      render();
    } else {
      close();
    }
  });
  $('help-overlay').addEventListener('click', (e) => {
    if (e.target === $('help-overlay')) close();
  });
}
