import { render } from 'preact';
import { App } from './App';
import { exposeTrace } from './pageTrace';
import './styles.css';

exposeTrace();
render(<App />, document.getElementById('app')!);
